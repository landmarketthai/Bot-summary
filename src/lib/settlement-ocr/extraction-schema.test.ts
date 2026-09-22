import { describe, expect, it } from "bun:test";
import {
  checkSettlementArithmetic,
  DOCUMENT_TYPE_CONFIDENCE_THRESHOLD,
  FIELD_CONFIDENCE_THRESHOLD,
  isFieldConfident,
  isLikelySettlementSheet,
  parseSettlementSheetDate,
  parseSettlementSheetExtraction,
} from "./extraction-schema";

function moneyField(value: number | null, confidence = 0.95) {
  return { value, confidence };
}

describe("parseSettlementSheetExtraction", () => {
  it("parses a well-formed valid-sheet payload", () => {
    const extraction = parseSettlementSheetExtraction({
      document_type: "SETTLEMENT_SHEET",
      document_type_confidence: 0.97,
      market_text: "วัดทุ่งลานนา",
      date_text: "21/9/69",
      staff_text: "กี้",
      sales_total: { value: 5123, confidence: 0.9 },
      transfer_amount: { value: 2123, confidence: 0.95 },
      cash_submitted: { value: 2800, confidence: 0.95 },
      expenses_total: { value: 200, confidence: 0.9 },
      expense_items: [{ label: "ค่าถุง", amount: 200 }],
      labor_total: { value: 550, confidence: 0.9 },
      labor_items: [{ label: "เก็ท", amount: 550 }],
      cash_remaining: { value: 2250, confidence: 0.85 },
    });

    expect(extraction.documentType).toBe("SETTLEMENT_SHEET");
    expect(extraction.marketText).toBe("วัดทุ่งลานนา");
    expect(extraction.dateText).toBe("21/9/69");
    expect(extraction.transferAmount).toEqual({ value: 2123, confidence: 0.95 });
    expect(extraction.expenseItems).toEqual([{ label: "ค่าถุง", amount: 200 }]);
    expect(extraction.laborItems).toEqual([{ label: "เก็ท", amount: 550 }]);
  });

  it("falls back to OTHER for an unrecognized document_type", () => {
    const extraction = parseSettlementSheetExtraction({
      document_type: "SOMETHING_ELSE",
      document_type_confidence: 0.9,
      market_text: null,
      date_text: null,
      staff_text: null,
      sales_total: { value: null, confidence: 0 },
      transfer_amount: { value: null, confidence: 0 },
      cash_submitted: { value: null, confidence: 0 },
      expenses_total: { value: null, confidence: 0 },
      expense_items: [],
      labor_total: { value: null, confidence: 0 },
      labor_items: [],
      cash_remaining: { value: null, confidence: 0 },
    });
    expect(extraction.documentType).toBe("OTHER");
  });

  it("rejects a negative money value rather than accepting it", () => {
    const field = parseSettlementSheetExtraction({
      document_type: "SETTLEMENT_SHEET",
      document_type_confidence: 0.9,
      market_text: null,
      date_text: null,
      staff_text: null,
      sales_total: { value: -5, confidence: 0.9 },
      transfer_amount: { value: null, confidence: 0 },
      cash_submitted: { value: null, confidence: 0 },
      expenses_total: { value: null, confidence: 0 },
      expense_items: [],
      labor_total: { value: null, confidence: 0 },
      labor_items: [],
      cash_remaining: { value: null, confidence: 0 },
    }).salesTotal;
    expect(field.value).toBeNull();
  });

  it("throws on a non-object result", () => {
    expect(() => parseSettlementSheetExtraction(null)).toThrow();
    expect(() => parseSettlementSheetExtraction("nope")).toThrow();
  });
});

describe("parseSettlementSheetDate (B.E. conversion)", () => {
  it("converts 21/9/69 to 2026-09-21", () => {
    expect(parseSettlementSheetDate("21/9/69")).toBe("2026-09-21");
  });

  it("converts a 4-digit B.E. year", () => {
    expect(parseSettlementSheetDate("21/9/2569")).toBe("2026-09-21");
  });

  it("returns null for an unrecognized format rather than guessing", () => {
    expect(parseSettlementSheetDate("21 ก.ย. 69")).toBeNull();
    expect(parseSettlementSheetDate("garbled")).toBeNull();
    expect(parseSettlementSheetDate(null)).toBeNull();
  });

  it("returns null for a calendar-invalid date", () => {
    expect(parseSettlementSheetDate("31/2/69")).toBeNull();
  });
});

describe("checkSettlementArithmetic", () => {
  // The P0 mapping bug: the real handwritten-sheet example. money_cash MUST
  // map to cash_remaining (2250), never cash_submitted (2800). Both
  // sheet-internal equations hold here, and so does the existing-system
  // equation (sales = transfer + cash_remaining + expenses + labor).
  it("P0: exact 5123/2123/200/2800/550/2250 mapping — both equations pass", () => {
    const result = checkSettlementArithmetic({
      salesTotal: 5123,
      transferAmount: 2123,
      expensesTotal: 200,
      cashSubmitted: 2800,
      laborTotal: 550,
      cashRemaining: 2250,
    });
    expect(result.ledgerOk).toBe(true); // 5123 = 2123 + 2800 + 200
    expect(result.cashOk).toBe(true); // 2800 = 2250 + 550
    expect(result.expectedSales).toBe(5123); // 2123 + 2250 + 200 + 550
    expect(result.difference).toBe(0);
    expect(result.ok).toBe(true);
  });

  it("cash_submitted != money_cash: cash_remaining is what feeds expectedSales, not cash_submitted", () => {
    const result = checkSettlementArithmetic({
      salesTotal: null,
      transferAmount: 2123,
      expensesTotal: 200,
      cashSubmitted: 999999, // deliberately absurd — must be ignored by expectedSales
      laborTotal: 550,
      cashRemaining: 2250,
    });
    expect(result.expectedSales).toBe(2123 + 2250 + 200 + 550);
  });

  it("flags the sheet's own ledger line when it fails, independent of the cash line", () => {
    const result = checkSettlementArithmetic({
      salesTotal: 9999,
      transferAmount: 2123,
      expensesTotal: 200,
      cashSubmitted: 2800,
      laborTotal: 550,
      cashRemaining: 2250,
    });
    expect(result.ledgerOk).toBe(false);
    expect(result.cashOk).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("flags the sheet's own cash-handout line when it fails, independent of the ledger line", () => {
    const result = checkSettlementArithmetic({
      salesTotal: 5123,
      transferAmount: 2123,
      expensesTotal: 200,
      cashSubmitted: 2800,
      laborTotal: 999,
      cashRemaining: 2250,
    });
    expect(result.cashOk).toBe(false);
    expect(result.ledgerOk).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("never invents a missing required field as zero — each equation stays null without its inputs", () => {
    const result = checkSettlementArithmetic({
      salesTotal: 5123,
      transferAmount: 2123,
      expensesTotal: 200,
      cashSubmitted: null,
      laborTotal: 550,
      cashRemaining: 2250,
    });
    expect(result.ledgerOk).toBeNull();
    expect(result.cashOk).toBeNull();
    expect(result.expectedSales).toBe(2123 + 2250 + 200 + 550);
    expect(result.ok).toBe(true); // only the sales-vs-expectedSales check ran, and it passed
  });

  it("reports null ok when literally nothing could be checked", () => {
    const result = checkSettlementArithmetic({
      salesTotal: null,
      transferAmount: null,
      expensesTotal: null,
      cashSubmitted: null,
      laborTotal: null,
      cashRemaining: null,
    });
    expect(result.expectedSales).toBeNull();
    expect(result.difference).toBeNull();
    expect(result.ok).toBeNull();
  });

  it("is exact at the cent (no float drift)", () => {
    const result = checkSettlementArithmetic({
      salesTotal: 0.3,
      transferAmount: 0.1,
      expensesTotal: 0.1,
      cashSubmitted: 0.1,
      laborTotal: 0,
      cashRemaining: 0.1,
    });
    expect(result.ok).toBe(true);
  });
});

describe("confidence gating", () => {
  it("treats a low-confidence read as not confident, even with a value", () => {
    expect(isFieldConfident(moneyField(100, FIELD_CONFIDENCE_THRESHOLD - 0.01))).toBe(false);
    expect(isFieldConfident(moneyField(100, FIELD_CONFIDENCE_THRESHOLD))).toBe(true);
  });

  it("treats a null value as never confident regardless of the confidence score", () => {
    expect(isFieldConfident(moneyField(null, 0.99))).toBe(false);
  });

  it("requires both SETTLEMENT_SHEET type and threshold confidence to be 'likely'", () => {
    const base = parseSettlementSheetExtraction({
      document_type: "SETTLEMENT_SHEET",
      document_type_confidence: DOCUMENT_TYPE_CONFIDENCE_THRESHOLD,
      market_text: null, date_text: null, staff_text: null,
      sales_total: { value: null, confidence: 0 },
      transfer_amount: { value: null, confidence: 0 },
      cash_submitted: { value: null, confidence: 0 },
      expenses_total: { value: null, confidence: 0 },
      expense_items: [],
      labor_total: { value: null, confidence: 0 },
      labor_items: [],
      cash_remaining: { value: null, confidence: 0 },
    });
    expect(isLikelySettlementSheet(base)).toBe(true);

    const lowConfidence = { ...base, documentTypeConfidence: DOCUMENT_TYPE_CONFIDENCE_THRESHOLD - 0.01 };
    expect(isLikelySettlementSheet(lowConfidence)).toBe(false);

    const wrongType = { ...base, documentType: "OTHER" as const };
    expect(isLikelySettlementSheet(wrongType)).toBe(false);
  });
});
