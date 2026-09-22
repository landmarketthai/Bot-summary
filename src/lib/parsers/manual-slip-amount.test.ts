import { describe, expect, it } from "bun:test";
import { parseManualSlipAmounts } from "./manual-slip-amount";

describe("parseManualSlipAmounts", () => {
  it("parses numbered dot prefix with บาท", () => {
    expect(parseManualSlipAmounts("1. 100 บาท")).toEqual([{ rawLine: "1. 100 บาท", amount: 100 }]);
  });

  it("parses numbered paren prefix without บาท", () => {
    expect(parseManualSlipAmounts("1) 300")).toEqual([{ rawLine: "1) 300", amount: 300 }]);
  });

  it("parses bare amount with บาท", () => {
    expect(parseManualSlipAmounts("100 บาท")).toEqual([{ rawLine: "100 บาท", amount: 100 }]);
  });

  it("parses the quoted-slip label grammar", () => {
    expect(parseManualSlipAmounts("\u0e22\u0e2d\u0e14 268")).toEqual([
      { rawLine: "\u0e22\u0e2d\u0e14 268", amount: 268 },
    ]);
  });

  it("parses comma-formatted amount with บาท", () => {
    expect(parseManualSlipAmounts("1,200 บาท")).toEqual([{ rawLine: "1,200 บาท", amount: 1200 }]);
  });

  it("parses decimal amount", () => {
    expect(parseManualSlipAmounts("100.50 บาท")).toEqual([{ rawLine: "100.50 บาท", amount: 100.5 }]);
  });

  it("parses multi-line message accumulating multiple amounts", () => {
    const text = "1. 100 บาท\n2. 300 บาท\n3. 500 บาท";
    const result = parseManualSlipAmounts(text);
    expect(result).toHaveLength(3);
    expect(result.map(r => r.amount)).toEqual([100, 300, 500]);
  });

  it("skips empty lines and non-amount lines", () => {
    const text = "สวัสดี\n100 บาท\n\nขอบคุณ";
    const result = parseManualSlipAmounts(text);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(100);
  });

  it("returns empty array for text with no amounts", () => {
    expect(parseManualSlipAmounts("สวัสดีครับ")).toEqual([]);
    expect(parseManualSlipAmounts("")).toEqual([]);
  });

  it("does not match bare number without prefix or บาท", () => {
    // "300" alone has no บาท and no prefix — not matched
    expect(parseManualSlipAmounts("300")).toEqual([]);
  });

  it("preserves raw line exactly", () => {
    const result = parseManualSlipAmounts("2) 500 บาท");
    expect(result[0].rawLine).toBe("2) 500 บาท");
  });

  // Compact indexed format: "1.90" = sequence 1, amount 90
  it("parses compact indexed 1.90 as amount 90", () => {
    expect(parseManualSlipAmounts("1.90")).toEqual([{ rawLine: "1.90", amount: 90 }]);
  });

  it("parses compact indexed 2.160 as amount 160", () => {
    expect(parseManualSlipAmounts("2.160")).toEqual([{ rawLine: "2.160", amount: 160 }]);
  });

  it("parses compact indexed with บาท: 1.90 บาท → 90", () => {
    expect(parseManualSlipAmounts("1.90 บาท")).toEqual([{ rawLine: "1.90 บาท", amount: 90 }]);
  });

  it("parses compact indexed with บาท: 2.160 บาท → 160", () => {
    expect(parseManualSlipAmounts("2.160 บาท")).toEqual([{ rawLine: "2.160 บาท", amount: 160 }]);
  });

  it("does NOT treat 100.50 บาท as compact indexed — decimal wins", () => {
    expect(parseManualSlipAmounts("100.50 บาท")).toEqual([{ rawLine: "100.50 บาท", amount: 100.5 }]);
  });

  it("parses multiline compact amounts", () => {
    const result = parseManualSlipAmounts("1.90\n2.160");
    expect(result.map(r => r.amount)).toEqual([90, 160]);
  });
});
