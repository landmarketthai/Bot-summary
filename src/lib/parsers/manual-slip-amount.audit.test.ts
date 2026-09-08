import { describe, expect, it } from "bun:test";
import { parseManualSlipAmounts } from "./manual-slip-amount";

describe("manual slip decimal audit regressions", () => {
  it("keeps real two-digit monetary decimals exact", () => {
    expect(parseManualSlipAmounts("10.50 บาท")).toEqual([{ rawLine: "10.50 บาท", amount: 10.5 }]);
    expect(parseManualSlipAmounts("99.99 บาท")).toEqual([{ rawLine: "99.99 บาท", amount: 99.99 }]);
    expect(parseManualSlipAmounts("1,200.50 บาท")).toEqual([{ rawLine: "1,200.50 บาท", amount: 1200.5 }]);
  });

  it("preserves legacy compact-index forms", () => {
    expect(parseManualSlipAmounts("1.90")).toEqual([{ rawLine: "1.90", amount: 90 }]);
    expect(parseManualSlipAmounts("1.90 บาท")).toEqual([{ rawLine: "1.90 บาท", amount: 90 }]);
    expect(parseManualSlipAmounts("2.160 บาท")).toEqual([{ rawLine: "2.160 บาท", amount: 160 }]);
  });
});
