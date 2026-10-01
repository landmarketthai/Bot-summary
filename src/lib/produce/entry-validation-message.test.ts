import { describe, expect, it } from "bun:test";
import {
  countCodePoints,
  LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
} from "@/lib/summary/line-chunking";
import type {
  ProduceValidationResult,
  ProduceValidationReview,
} from "./entry-validation";
import {
  buildBlockingValidationReply,
  buildPlainTextReviewValidationReply,
  buildReviewValidationReply,
} from "./entry-validation-message";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";

function review(
  itemNumber: number,
  productName: string,
): ProduceValidationReview {
  return {
    kind: "unknown_product_vocabulary",
    severity: "review_required",
    itemNumber,
    productName,
    suggestions: [{ productCode: "ม63", canonicalName: "มะม่วงจิ้ว" }],
  };
}

function result(...reviews: ProduceValidationReview[]): ProduceValidationResult {
  return {
    status: "review_required",
    blocking: [],
    reviews,
    advisories: [],
    digest: "review-digest",
  };
}

describe("unknown-product review actions", () => {
  it("makes keep-and-save and correction choices explicit for one product", () => {
    const reply = buildPlainTextReviewValidationReply(
      result(review(4, "มะม่วง")),
      "จบรายการเบิก",
    );

    expect(reply).toContain("✅ ถ้าชื่อนี้ถูกต้องและต้องการบันทึกตามที่พิมพ์");
    expect(reply).toContain("ส่ง “จบรายการเบิก” อีกครั้ง");
    expect(reply).toContain("✏️ ถ้าต้องการแก้ชื่อ");
    expect(reply).toContain("ส่ง “แก้ข้อ 4”");
    expect(reply).toContain("แล้วส่งข้อ 4 ใหม่ พร้อมราคาและจำนวน");
    expect(reply).toEndWith("รายการอื่นยังอยู่ครบ ไม่ต้องเริ่มใหม่");
  });

  it.each([
    "จบรายการเบิก",
    "จบรายการชั่งคืน",
    "จบรายการคืนเสีย",
    "จบรายการเบิกเพิ่ม 4 รายการ",
  ])("repeats the active plain-text close command exactly: %s", (closeCommand) => {
    const reply = buildPlainTextReviewValidationReply(
      result(review(4, "มะม่วง")),
      closeCommand,
    );
    expect(reply).toContain(`ส่ง “${closeCommand}” อีกครั้ง`);
  });

  it("keeps the structured-session confirmation button prominent", () => {
    const reply = buildReviewValidationReply(result(review(4, "มะม่วง")));
    expect(reply).toContain("✅ ถ้าชื่อนี้ถูกต้องและต้องการบันทึกตามที่พิมพ์");
    expect(reply).toContain("กด “ยืนยัน” เพื่อบันทึกและจบรายการ");
    expect(reply).toContain("✏️ ถ้าต้องการแก้ชื่อ");
  });

  it("keeps multiple products readable with one concise correction pattern", () => {
    const reply = buildPlainTextReviewValidationReply(
      result(
        review(1, "ผลไม้หนึ่ง"),
        review(8, "ผลไม้แปด"),
        review(20, "ผลไม้ยี่สิบ"),
      ),
      "จบรายการเบิก",
    );

    expect(reply).toContain("ข้อ 1 — ผลไม้หนึ่ง");
    expect(reply).toContain("ข้อ 8 — ผลไม้แปด");
    expect(reply).toContain("ข้อ 20 — ผลไม้ยี่สิบ");
    expect(reply).toContain("✅ ถ้าชื่อเหล่านี้ถูกต้องและต้องการบันทึกตามที่พิมพ์");
    expect(reply).toContain("ส่งคำสั่ง “แก้ข้อ <เลขข้อ>” ทีละข้อ");
  });

  it("truncates issue details before the required action block", () => {
    const reviews = Array.from({ length: 25 }, (_, index) =>
      review(index + 1, `สินค้ายาว${index + 1}${"ก".repeat(1_000)}`),
    );
    const reply = buildPlainTextReviewValidationReply(
      result(...reviews),
      "จบรายการเบิก",
    );

    expect(countCodePoints(reply)).toBeLessThanOrEqual(
      LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS,
    );
    expect(reply).toContain("และอีก");
    expect(reply).toContain("✅ ถ้าชื่อเหล่านี้ถูกต้องและต้องการบันทึกตามที่พิมพ์");
    expect(reply).toContain("ส่ง “จบรายการเบิก” อีกครั้ง");
    expect(reply).toContain("✏️ ถ้าต้องการแก้ชื่อ");
    expect(reply).toEndWith("รายการอื่นยังอยู่ครบ ไม่ต้องเริ่มใหม่");
  });
});

describe("blocked document value preview", () => {
  const blocked: ProduceValidationResult = {
    status: "blocked",
    blocking: [{
      kind: "unit_not_withdrawn",
      severity: "blocking",
      itemNumber: 1,
      productName: "หมอนทอง",
      unit: "ลูก",
      withdrawnUnits: ["โล"],




    }],
    reviews: [],
    advisories: [],
    digest: "blocked-digest",
  };

  it("shows all 79 return lines without claiming sales or a confirmed shortage", () => {
    const items = Array.from({ length: 79 }, (_, index) =>
      `${index + 1}.หมอนทอง${index === 78 ? "4541.83" : "100"}บาท\n1โล`,
    );
    const parsed = parseWeighSession(`ดำ-ทุ่งลานนา ชั่งคืน 29/9/2569\n${items.join("\n")}\nจบรายการชั่งคืน`, "2026-09-29");
    expect(parsed.items).toHaveLength(79);
    const reply = buildBlockingValidationReply(blocked, undefined, parsed);
    expect(reply).toContain("ชั่งคืน 79 รายการ: 12,341.83 บาท");
    expect(reply).toContain("ยังไม่บันทึก/ยังไม่ยืนยัน");
    expect(reply).toContain("ยังไม่ใช่ยอดขายหรือยอดเงินขาดที่ยืนยันแล้ว");
    expect(reply).toContain("รายการอื่นยังอยู่ครบ");
    expect(reply).not.toContain("เบิก 0 รายการ");
    expect(reply).not.toContain("แก้เฉพาะรายการที่ทำให้ยอดเกิน");
    expect(countCodePoints(reply)).toBeLessThanOrEqual(LINE_TEXT_MESSAGE_HARD_MAX_CODE_POINTS);
  });

  it("aggregates unit rows before rounding and keeps bundled-price totals", () => {
    const parsed = parseWeighSession("ดำ-ทุ่งลานนา ชั่งคืน 29/9/2569\n1.หมอนทอง8.29บาท\n3.5โล\n2.หมอนทอง8.29บาท\n3.5โล\n3.มะพร้าว3หัว20บาท\n32หัว\nจบรายการชั่งคืน", "2026-09-29");
    expect(parsed.items).toHaveLength(3);
    expect(buildBlockingValidationReply(blocked, undefined, parsed)).toContain("ชั่งคืน 3 รายการ: 271.36 บาท");
  });

  it("does not turn missing quantities into zero or a partial total", () => {
    const parsed = parseWeighSession("ดำ-ทุ่งลานนา ชั่งคืน 29/9/2569\n1.หมอนทอง100บาท\n1โล\nจบรายการชั่งคืน", "2026-09-29");
    parsed.items[0].quantity = null;
    const reply = buildBlockingValidationReply(blocked, undefined, parsed);
    expect(reply).toContain("ชั่งคืน 1 รายการ: ยังคำนวณครบไม่ได้");
    expect(reply).not.toContain("0.00 บาท");
  });

  it("keeps the preview and correction instructions when long issue details are omitted", () => {
    const parsed = parseWeighSession("ดำ-ทุ่งลานนา ชั่งคืน 29/9/2569\n1.หมอนทอง100บาท\n1โล\nจบรายการชั่งคืน", "2026-09-29");
    const oversized: ProduceValidationResult = {
      ...blocked,
      blocking: blocked.blocking.map((entry) => ({ ...entry, productName: "ก".repeat(5000) })),
    };
    const reply = buildBlockingValidationReply(oversized, 1000, parsed);
    expect(countCodePoints(reply)).toBeLessThanOrEqual(1000);
    expect(reply).toContain("ชั่งคืน 1 รายการ: 100.00 บาท");
    expect(reply).toContain("รายการอื่นยังอยู่ครบ");
    expect(reply).toContain('แล้วส่งข้อความ "จบรายการ" อีกครั้ง');
  });
});
