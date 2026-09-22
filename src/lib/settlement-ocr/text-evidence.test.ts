import { describe, expect, it } from "bun:test";
import { parseTypedAmountText, reconcileTypedAmount } from "./text-evidence";

describe("parseTypedAmountText", () => {
  it("parses a bare number", () => {
    expect(parseTypedAmountText("268")).toBe(268);
  });

  it("parses \"ยอด <number>\"", () => {
    expect(parseTypedAmountText("ยอด 268")).toBe(268);
    expect(parseTypedAmountText("ยอด268")).toBe(268);
  });

  it("accepts thousands separators and cents", () => {
    expect(parseTypedAmountText("2,250.50")).toBe(2250.5);
  });

  it("returns null for non-numeric or unrelated text rather than guessing", () => {
    expect(parseTypedAmountText("สวัสดี")).toBeNull();
    expect(parseTypedAmountText("ยอดขายวันนี้ดีมาก")).toBeNull();
    expect(parseTypedAmountText("")).toBeNull();
  });

  it("rejects a negative number", () => {
    expect(parseTypedAmountText("-268")).toBeNull();
  });
});

describe("reconcileTypedAmount", () => {
  it("reports no_typed_amount when nothing was typed", () => {
    expect(reconcileTypedAmount(null, 268)).toEqual({ kind: "no_typed_amount" });
  });

  it("matches when the typed and extracted amounts agree — strengthens review context", () => {
    expect(reconcileTypedAmount(268, 268)).toEqual({ kind: "match", amount: 268 });
  });

  it("matches within an explicit tolerance", () => {
    expect(reconcileTypedAmount(268, 268.004, 0.01).kind).toBe("match");
  });

  it("is a human-confirmation candidate when OCR read nothing but text was typed", () => {
    expect(reconcileTypedAmount(268, null)).toEqual({ kind: "ocr_null_candidate", typedAmount: 268 });
  });

  it("forces review on a mismatch instead of silently trusting either source", () => {
    expect(reconcileTypedAmount(268, 280)).toEqual({
      kind: "mismatch",
      typedAmount: 268,
      extractedAmount: 280,
    });
  });

  it("is exact at the cent (no float drift)", () => {
    expect(reconcileTypedAmount(0.1, 0.1).kind).toBe("match");
  });
});
