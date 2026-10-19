import { describe, expect, test } from "bun:test";
import { buildBatchSummaryMessage, type EvidenceWithCheck } from "./batch-finalizer";

const evidence = (index: number, reason: string): EvidenceWithCheck => ({
  id: "evidence-" + index,
  batchIndex: index,
  checkStatus: "NEED_REVIEW",
  slipType: "THAI_HELP_THAI",
  transferAmount: null,
  paidAmount: 40,
  grossAmount: 100,
  discountAmount: 60,
  transactionTime: "2026-10-19T07:00:00Z",
  referenceId: index === 3 ? null : "TEST-REF-" + index,
  failureReason: reason,
});

describe("global duplicate rejection in LINE batch summary", () => {
  test("all held items display their exact reasons, never a trusted total", () => {
    const message = buildBatchSummaryMessage([
      evidence(1, "duplicate_transaction_reference_global"),
      evidence(2, "duplicate_image_sha256_global"),
      evidence(3, "missing_transaction_reference_global"),
    ], { slipDate: "19/10/2569" });
    expect(message).toContain("อ่านครบ: 0 รูป");
    expect(message).toContain("รอตรวจมือ: 3 รูป");
    expect(message).toContain("#1 สลิปซ้ำ (รหัสอ้างอิงเคยใช้แล้ว)");
    expect(message).toContain("#2 สลิปซ้ำ (รูปเดิมเคยส่งแล้ว)");
    expect(message).toContain("#3 ไม่พบรหัสอ้างอิง (รอตรวจมือ)");
    expect(message).not.toContain("ยอดรวมที่อ่านได้:");
  });
});
