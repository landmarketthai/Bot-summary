import { describe, expect, it } from "bun:test";
import { buildBatchSummaryMessage, type EvidenceWithCheck } from "./batch-finalizer";

const correctDate = "2026-10-30T08:41:00.000Z"; // 15:41 Bangkok
const title = "สรุปชุดสลิปเงินโอน จ๋า — ทรัพย์พันธ์ — 30/10/2569";

function bank(
  image: number,
  amount: number | null,
  status: EvidenceWithCheck["checkStatus"] = "EXTRACTED",
  options: {
    date?: string | null;
    ref?: string | null;
    fallback?: string | null;
    issue?: EvidenceWithCheck["bankVerificationIssue"];
  } = {},
): EvidenceWithCheck {
  return {
    id: "image-" + image,
    batchIndex: image,
    checkStatus: status,
    slipType: "BANK_SLIP_QR",
    transferAmount: amount,
    paidAmount: null,
    transactionTime: options.date === undefined ? correctDate : options.date,
    referenceId: options.ref === undefined ? "REF-" + image : options.ref,
    ocrFallbackReason: options.fallback ?? null,
    bankVerificationIssue: options.issue ?? null,
    failureReason: null,
  };
}

function summarize(evidences: EvidenceWithCheck[], date: string | null = "30/10/2569"): string {
  return buildBatchSummaryMessage(evidences, { title, slipDate: date });
}

describe("human-readable LINE slip summary — amount read versus money verified", () => {
  it("sums 290 bank-verified plus 100 OCR-readable and makes no one re-add the 100", () => {
    const evidences = [
      bank(1, 40),
      bank(2, 100, "NEED_REVIEW", { fallback: "provider_error" }),
      bank(3, 80),
      bank(4, 20),
      bank(5, 70),
      bank(6, 80),
    ];
    const before = evidences.map((e) => e.checkStatus);
    const message = summarize(evidences);
    expect(message).toContain("จ๋า");
    expect(message).toContain("30/10/2569");
    expect(message).toContain("อ่านยอดได้: 6 รูป");
    expect(message).toContain("ยอดรวมที่อ่านได้: 390 บาท");
    for (const [number, amount] of [[1, 40], [2, 100], [3, 80], [4, 20], [5, 70], [6, 80]]) {
      expect(message).toContain("รูปที่ " + number + " = " + amount + " บาท");
    }
    expect(message).toContain("รูปที่ 2 — 100 บาท: ยังตรวจสอบเงินเข้าไม่ได้");
    expect(message).toContain("รวมยอดแล้ว");
    expect(message).toContain("ไม่ต้องบวกเพิ่ม");
    expect(message).not.toContain("ยอดรวมที่อ่านได้: 490 บาท");
    expect(message).not.toContain("provider_error");
    expect(message).not.toContain("NEED_REVIEW");
    expect(message).not.toContain("EasySlip");
    expect(message).not.toContain("OCR");
    expect(evidences.map((e) => e.checkStatus)).toEqual(before); // report never mutates bank approval
    expect(evidences[1].checkStatus).toBe("NEED_REVIEW");
  });

  it("prefers an already verified slip to the same bank reference in an earlier unverified image", () => {
    const message = summarize([
      bank(1, 100, "NEED_REVIEW", { fallback: "provider_error", ref: "REF-SAME" }),
      bank(2, 80, "EXTRACTED", { ref: "REF-SAME" }),
    ]);
    expect(message).toContain("ยอดรวมที่อ่านได้: 80 บาท");
    expect(message).not.toContain("ยอดรวมที่อ่านได้: 180 บาท");
    expect(message).toContain("สลิปซ้ำ");
    expect(message).toContain("ยังไม่รวมยอด");
  });

  it("does not count duplicate or wrong-receiver bank verification results", () => {
    const message = summarize([
      bank(1, 40),
      bank(2, 100, "NEED_REVIEW", { issue: "duplicate" }),
      bank(3, 200, "NEED_REVIEW", { issue: "receiver_mismatch" }),
    ]);
    expect(message).toContain("ยอดรวมที่อ่านได้: 40 บาท");
    expect(message).toContain("พบสลิปซ้ำ");
    expect(message).toContain("บัญชีผู้รับเงินไม่ตรง");
    expect(message).not.toContain("ยอดรวมที่อ่านได้: 340 บาท");
  });

  it("does not include OCR-only slips one day away even though the legacy verified guard allows one day", () => {
    const message = summarize([
      bank(1, 40),
      bank(2, 100, "NEED_REVIEW", {
        fallback: "slip_not_found", date: "2026-10-29T08:41:00.000Z",
      }),
    ]);
    expect(message).toContain("ยอดรวมที่อ่านได้: 40 บาท");
    expect(message).toContain("วันที่โอนเงินไม่ตรงกับวันที่ขาย");
    expect(message).not.toContain("ยอดรวมที่อ่านได้: 140 บาท");
  });

  it("rejects an absent or invalid date, missing batch date, and unreadable amount", () => {
    for (const [amount, date, batchDate] of [
      [100, null, "30/10/2569"],
      [100, "unparseable", "30/10/2569"],
      [100, correctDate, null],
      [null, correctDate, "30/10/2569"],
    ] as const) {
      const message = summarize([
        bank(1, 40),
        bank(2, amount, "NEED_REVIEW", { date, fallback: "provider_error" }),
      ], batchDate);
      expect(message).toContain("ยอดรวมที่อ่านได้: 40 บาท");
      expect(message).not.toContain("ยอดรวมที่อ่านได้: 140 บาท");
      expect(message).toContain("ยังไม่รวมยอด");
    }
  });

  it("does not count an unverified image when OCR provenance is missing or not a known fallback", () => {
    for (const fallback of [null, "unknown_reason"]) {
      const message = summarize([
        bank(1, 40),
        bank(2, 100, "NEED_REVIEW", { fallback }),
      ]);
      expect(message).toContain("ยอดรวมที่อ่านได้: 40 บาท");
      expect(message).not.toContain("ยอดรวมที่อ่านได้: 140 บาท");
    }
  });

  it("high-value suspicious OCR amount stays outside the total", () => {
    const evidences = [
      ...Array.from({ length: 5 }, (_, i) => bank(i + 1, 100)),
      bank(6, 50_000, "NEED_REVIEW", { fallback: "provider_error" }),
    ];
    const message = summarize(evidences);
    expect(message).toContain("ยอดรวมที่อ่านได้: 500 บาท");
    expect(message).toContain("ยอดเงินสูงผิดปกติ");
    expect(message).not.toContain("ยอดรวมที่อ่านได้: 50,500 บาท");
  });

  it("can count a dated OCR amount with missing reference, while explicitly noting that missing detail", () => {
    const message = summarize([bank(1, 100, "NEED_REVIEW", { fallback: "provider_error", ref: null })]);
    expect(message).toContain("ยอดรวมที่อ่านได้: 100 บาท");
    expect(message).toContain("เลขอ้างอิงยังไม่ชัด");
    expect(message).toContain("รวมยอดแล้ว");
  });

  it("keeps prior gross-amount policy for government receipts", () => {
    const evidence = {
      ...bank(1, null),
      slipType: "THAI_HELP_THAI" as const,
      grossAmount: 100,
      paidAmount: 70,
      discountAmount: 30,
    };
    const message = summarize([evidence]);
    expect(message).toContain("ยอดรวมที่อ่านได้: 100 บาท");
  });

  it("keeps a large batch of fifty unverified but readable slips within one LINE message", () => {
    const images = Array.from({ length: 50 }, (_, i) => bank(i + 1, 100, "NEED_REVIEW", {
      fallback: "provider_error",
    }));
    const message = summarize(images);
    expect(message).toContain("ยอดรวมที่อ่านได้: 5,000 บาท");
    expect(message).toContain("รูปที่ 50 = 100 บาท");
    expect(message).toContain("รูปที่ 50 — 100 บาท");
    expect(message.length).toBeLessThanOrEqual(5000);
  });
});
