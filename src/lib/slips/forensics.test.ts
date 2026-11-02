import { describe, expect, test } from "bun:test";
import type { SlipExtraction } from "@/lib/slips/extraction-schema";
import { countOrUnknown, diagnoseSlipImage, missingForConfirmation, optionalRows } from "@/lib/slips/forensics";

const base: SlipExtraction = {
  slipType: "BANK_SLIP_QR", grossAmount: null, discountAmount: null, paidAmount: null, transferAmount: 40,
  referenceId: "REF1", transactionTime: "2026-10-29T05:00:00.000Z", senderName: null, receiverName: null,
  receiverAccountTail: null, paymentChannelText: null, headlineTotalAmount: null, confidence: 0.9,
};
const check = (e: Partial<SlipExtraction> | null, status: "EXTRACTED" | "NEED_REVIEW" | "FAILED" | "PROCESSING" = "EXTRACTED") =>
  ({ status, failureReason: status === "FAILED" ? "extractor_http_timeout" : null, extraction: e ? { ...base, ...e } : null });
const noFlags = { effectiveAmount: 40, flagged: false, flagReasons: [] };

describe("diagnoseSlipImage explains which existing rule applied", () => {
  test("confirmed bank slip", () => {
    expect(diagnoseSlipImage(true, check({}), noFlags).diagnosis).toBe("CONFIRMED");
  });
  test("image never attached / OCR failed / OCR pending", () => {
    expect(diagnoseSlipImage(false, null, null).diagnosis).toBe("INGEST_FAILED");
    expect(diagnoseSlipImage(true, check(null, "FAILED"), null)).toEqual({ diagnosis: "OCR_FAILED", detail: ["extractor_http_timeout"] });
    expect(diagnoseSlipImage(true, check({}, "PROCESSING"), null).diagnosis).toBe("OCR_PENDING");
  });
  test("UNKNOWN type with a visible amount: not a payment type, amount reported", () => {
    const d = diagnoseSlipImage(true, check({ slipType: "UNKNOWN", headlineTotalAmount: 50, transferAmount: null }, "NEED_REVIEW"), null);
    expect(d).toEqual({ diagnosis: "NOT_A_PAYMENT_TYPE", detail: ["slip_type=UNKNOWN", "amount_seen=50"] });
  });
  test("amount read but no date, reference or receiver: status rule", () => {
    const d = diagnoseSlipImage(true, check({ transactionTime: null, referenceId: null }, "NEED_REVIEW"), null);
    expect(d.diagnosis).toBe("AMOUNT_READ_STATUS_RULE");
    expect(d.detail).toEqual(["status=NEED_REVIEW", "transaction_time", "reference_id"]);
  });
  test("Thai Help Thai with only the headline total: status rule names paid_amount", () => {
    const e = { slipType: "THAI_HELP_THAI" as const, transferAmount: null, headlineTotalAmount: 40, grossAmount: 40 };
    const d = diagnoseSlipImage(true, check(e, "NEED_REVIEW"), null);
    expect(d.diagnosis).toBe("AMOUNT_READ_STATUS_RULE");
    expect(d.detail).toContain("paid_amount");
  });
  test("no amount at all", () => {
    expect(diagnoseSlipImage(true, check({ transferAmount: null }, "NEED_REVIEW"), null).diagnosis).toBe("NO_AMOUNT_READ");
  });
  test("guard: date out of round vs duplicate only", () => {
    expect(diagnoseSlipImage(true, check({}), { effectiveAmount: 40, flagged: true, flagReasons: ["วันที่รายการไม่ตรงกับรอบ"] }).diagnosis)
      .toBe("AMOUNT_READ_GUARD");
    expect(diagnoseSlipImage(true, check({}), { effectiveAmount: 40, flagged: true, flagReasons: ["สลิปซ้ำ"] }).diagnosis)
      .toBe("AMOUNT_READ_DUPLICATE");
  });
  test("missing optional table: UNKNOWN, never zero; a readable table still counts", () => {
    const missing = optionalRows<{ check_id: string }>({
      data: null,
      error: { code: "PGRST205", message: "Could not find the table 'public.slip_check_amount_corrections' in the schema cache" },
    });
    expect(missing.available).toBe(false);
    expect(countOrUnknown(missing, () => true)).toBe("UNKNOWN");
    const present = optionalRows({ data: [{ check_id: "a" }, { check_id: "b" }], error: null });
    expect(countOrUnknown(present, (r) => r.check_id === "a")).toBe(1);
    expect(countOrUnknown(optionalRows<{ check_id: string }>({ data: [], error: null }), () => true)).toBe(0);
  });

  test("missingForConfirmation for a wallet slip", () => {
    expect(missingForConfirmation({ ...base, slipType: "GWALLET", transferAmount: null, paidAmount: 40 }))
      .toEqual(["gross_amount", "discount_amount"]);
  });
});
