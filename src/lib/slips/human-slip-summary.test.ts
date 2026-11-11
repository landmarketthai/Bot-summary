import { describe, expect, it } from "bun:test";
import { buildBatchSummaryMessage, type EvidenceWithCheck } from "./batch-finalizer";
import { computeValidationFlags, parseBatchDate } from "./validation-guard";

const correctDate = "2026-10-30T08:41:00.000Z"; // 15:41 Bangkok
const title = "สรุปชุดสลิปเงินโอน ผู้ทดสอบ — ตลาดสังเคราะห์ — 30/10/2569";

function bank(
  image: number,
  amount: number | null,
  status: EvidenceWithCheck["checkStatus"] = "EXTRACTED",
  options: {
    date?: string | null;
    ref?: string | null;
    referenceTrusted?: boolean;
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
    referenceTrusted: options.referenceTrusted ?? false,
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
    expect(message).toContain("ผู้ทดสอบ");
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
      bank(1, 100, "NEED_REVIEW", { fallback: "provider_error", ref: "REF-SAME", referenceTrusted: true }),
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

  it("includes readable amounts with absent or invalid dates, or a missing batch date", () => {
    for (const [date, batchDate] of [
      [null, "30/10/2569"],
      ["unparseable", "30/10/2569"],
      [correctDate, null],
    ] as const) {
      const message = summarize([
        bank(1, 40),
        bank(2, 100, "NEED_REVIEW", { date, fallback: "provider_error" }),
      ], batchDate);
      expect(message).toContain("ยอดรวมที่อ่านได้: 140 บาท");
      expect(message).toContain("รูปที่ 2 — 100 บาท: ยังตรวจสอบเงินเข้าไม่ได้");
      expect(message).toContain(date === correctDate ? "ยังไม่ทราบวันที่ของชุดสลิป" : "อ่านวันที่โอนเงินไม่ชัด");
      expect(message).toContain("รวมยอดแล้ว");
      expect(message).not.toContain("อ่านยอดและวันที่ได้แล้ว");
    }
  });

  it("totals all 11 synthetic images as 675, including image 11 once with its review note", () => {
    const amounts = [50, 30, 50, 70, 110, 40, 33, 90, 62, 100, 40];
    const unclearDates = new Set([1, 2, 5, 6]);
    const evidences = amounts.map((amount, i) => bank(i + 1, amount,
      unclearDates.has(i + 1) || i === 10 ? "NEED_REVIEW" : "EXTRACTED", {
        date: unclearDates.has(i + 1) ? null : correctDate,
        fallback: "provider_error",
      }));
    const before = structuredClone(evidences);
    const message = summarize(evidences);

    expect(message).toContain("ส่งสลิปมาทั้งหมด: 11 รูป");
    expect(message).toContain("อ่านยอดได้: 11 รูป");
    expect(message).toContain("ยอดรวมที่อ่านได้: 675 บาท");
    expect(message).not.toContain("ยอดรวมที่อ่านได้: 445 บาท");
    expect(message).toContain("มีรูปที่ต้องตรวจทาน: 5 รูป (อาจซ้ำกับรูปที่อ่านยอดได้)");
    for (const [i, amount] of amounts.entries()) {
      expect(message.split("\n").filter((line) => line === `รูปที่ ${i + 1} = ${amount} บาท`)).toHaveLength(1);
      if (unclearDates.has(i + 1)) {
        expect(message).toContain(`รูปที่ ${i + 1} — ${amount} บาท: ยังตรวจสอบเงินเข้าไม่ได้ อ่านวันที่โอนเงินไม่ชัด`);
      }
    }
    expect(message).toContain("รูปที่ 11 — 40 บาท: ยังตรวจสอบเงินเข้าไม่ได้ (รวมยอดแล้ว)");
    expect(message).toContain("ไม่ต้องบวกเพิ่ม");
    expect(message).toContain("ยังไม่ใช่ยอดยืนยันทางบัญชี");
    expect(evidences).toEqual(before);
  });

  it("keeps all 11 readable amounts when no image has a date, without changing accounting guards", () => {
    const amounts = [50, 30, 50, 70, 110, 40, 33, 90, 62, 100, 40];
    for (const status of ["EXTRACTED", "PARTIAL_EXTRACTED", "NEED_REVIEW"] as const) {
      for (const batchDate of ["30/10/2569", null]) {
        const evidences = amounts.map((amount, i) => bank(i + 1, amount, status, {
          date: i % 2 === 0 ? null : "unparseable",
          fallback: "provider_error",
        }));
        const before = structuredClone(evidences);
        const flagsBefore = computeValidationFlags(evidences, parseBatchDate(batchDate));
        const message = summarize(evidences, batchDate);
        expect(message).toContain("ยอดรวมที่อ่านได้: 675 บาท");
        expect(message).toContain("อ่านยอดได้: 11 รูป");
        expect(message).toContain("มีรูปที่ต้องตรวจทาน: 11 รูป (อาจซ้ำกับรูปที่อ่านยอดได้)");
        expect(message.match(/อ่านวันที่โอนเงินไม่ชัด/g)).toHaveLength(11);
        expect(evidences).toEqual(before);
        expect(computeValidationFlags(evidences, parseBatchDate(batchDate))).toEqual(flagsBefore);
        if (batchDate && status !== "NEED_REVIEW") {
          expect(flagsBefore.every((flag) => flag.flagged)).toBe(true);
        }
      }
    }
  });

  it("keeps undated duplicate images excluded, including duplicates of checked and fallback images", () => {
    for (const status of ["EXTRACTED", "NEED_REVIEW"] as const) {
      const images = [
        bank(1, 50, status, { date: null, ref: "SYNTHETIC-SAME", fallback: "provider_error", referenceTrusted: true }),
        bank(2, 50, "NEED_REVIEW", { date: null, ref: "SYNTHETIC-SAME", fallback: "provider_error", referenceTrusted: true }),
        { ...bank(3, 30, status, { date: null, fallback: "provider_error" }), globallyDuplicate: true },
        bank(4, 40, "NEED_REVIEW", { date: null, issue: "duplicate", fallback: "provider_error" }),
        bank(5, 60, "NEED_REVIEW", { date: null, issue: "receiver_mismatch", fallback: "provider_error" }),
      ];
      const message = summarize(images);
      expect(message).toContain("ยอดรวมที่อ่านได้: 50 บาท");
      expect(message).toContain("อ่านยอดได้: 1 รูป");
      expect(message).toContain("รูปที่ 2 — 50 บาท: สลิปซ้ำ");
      expect(message).toContain("รูปที่ 3 — 30 บาท: สลิปซ้ำ");
      expect(message).toContain("พบสลิปซ้ำ");
      expect(message).toContain("บัญชีผู้รับเงินไม่ตรง");
    }
  });

  it("excludes unreadable OCR amounts and pending checks even when an amount field exists", () => {
    for (const amount of [null, NaN, Infinity, 0, -100]) {
      const message = summarize([
        bank(1, 50, "NEED_REVIEW", { date: null, fallback: "provider_error" }),
        bank(2, amount, "NEED_REVIEW", { date: null, fallback: "provider_error" }),
        bank(3, 100, "PROCESSING", { date: null, fallback: "provider_error" }),
        bank(4, 100, null, { date: null, fallback: "provider_error" }),
        bank(5, 100, "FAILED", { date: null, fallback: "provider_error" }),
      ]);
      expect(message).toContain("ยอดรวมที่อ่านได้: 50 บาท");
      expect(message).toContain("อ่านยอดได้: 1 รูป");
      expect(message).toContain("ยังรอผล: 2 รูป");
      expect(message).toContain("อ่านไม่สำเร็จ: 1 รูป");
      expect(message).toContain("อ่านยอดเงินไม่ชัด");
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
