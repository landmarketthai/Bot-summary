import { describe, expect, it } from "bun:test";
import {
  calculateSettlementTotals,
  calculateYodSong,
  summarizeProduceTransactionRows,
  produceNetStatus,
} from "./transactions";

describe("summarizeProduceTransactionRows", () => {
  it("marks a zero-amount persisted row as present (known zero, not unknown)", () => {
    const { totals, presence } = summarizeProduceTransactionRows([
      { transaction_type: "เบิก", total_amount: 9000 },
      { transaction_type: "คืน", total_amount: 1000 },
      { transaction_type: "คืนเสีย", total_amount: 0 },
    ]);
    expect(presence).toEqual({ เบิก: true, คืน: true, คืนเสีย: true });
    expect(totals.คืนเสีย).toBe(0);
    expect(totals.ยอดส่ง).toBe(8000);
  });

  it("does not mark a bucket present just because totals default to 0", () => {
    const { totals, presence } = summarizeProduceTransactionRows([
      { transaction_type: "เบิก", total_amount: 9000 },
      { transaction_type: "คืน", total_amount: 1000 },
    ]);
    expect(presence.คืนเสีย).toBe(false);
    expect(totals.คืนเสีย).toBe(0);
  });

  it("does not convert a null persisted amount into known zero", () => {
    const { totals, presence } = summarizeProduceTransactionRows([
      { transaction_type: "เบิก", total_amount: 9000 },
      { transaction_type: "คืน", total_amount: 1000 },
      { transaction_type: "คืนเสีย", total_amount: null },
    ]);
    expect(presence.คืนเสีย).toBe(false);
    expect(totals.คืนเสีย).toBe(0);
  });

  it("excludes voided/superseded Produce because callers only pass effective rows", () => {
    // produce_transactions already drops voided sessions and superseded
    // predecessors. A คืนเสีย that never reached that view is not passed in.
    const { totals, presence, effectiveRowCount } = summarizeProduceTransactionRows([
      { transaction_type: "เบิก", total_amount: 13929.7 },
      { transaction_type: "คืน", total_amount: 10522.2 },
    ]);
    expect(effectiveRowCount).toBe(2);
    expect(presence).toEqual({ เบิก: true, คืน: true, คืนเสีย: false });
    expect(totals.คืนเสีย).toBe(0);
    expect(totals.ยอดส่ง).toBe(calculateYodSong(totals));
  });

  it("maps เบิกเพิ่ม and legacy เสีย onto the same buckets as the totals arithmetic", () => {
    const { totals, presence } = summarizeProduceTransactionRows([
      { transaction_type: "เบิกเพิ่ม", total_amount: 100 },
      { transaction_type: "เสีย", total_amount: 5 },
    ]);
    expect(presence.เบิก).toBe(true);
    expect(presence.คืนเสีย).toBe(true);
    expect(totals.เบิก).toBe(100);
    expect(totals.คืนเสีย).toBe(5);
    expect(totals.ยอดส่ง).toBe(95);
  });
});

describe("Produce net financial safety", () => {
  it("flags returns that exceed withdrawal instead of trusting a negative net", () => {
    expect(produceNetStatus({ เบิก: 200, คืน: 180, คืนเสีย: 60 }))
      .toBe("returns_exceed_withdrawal");
  });

  it("keeps normal and exact-zero net cases trusted", () => {
    expect(produceNetStatus({ เบิก: 200, คืน: 100, คืนเสีย: 50 })).toBe("trusted");
    expect(produceNetStatus({ เบิก: 200, คืน: 180, คืนเสีย: 20 })).toBe("trusted");
  });
});

describe("settlement money formula", () => {
  it("keeps ยอดขาย / เงินสดต้องส่งเจ๊ / ขาดเกิน independent of Produce confirmation", () => {
    const money = calculateSettlementTotals({
      ยอดส่ง: 3194.5,
      money_transfer: 1000,
      money_cash: 2000,
      expenses: 50,
      labor: 100,
    });
    expect(money.ยอดขาย).toBe(3150);
    expect(money.เงินสดต้องส่งเจ๊).toBe(2044.5);
    expect(money.ขาดเกิน).toBe(-44.5);
    expect(calculateYodSong({ เบิก: 9000, คืน: 1000, คืนเสีย: 568.5 })).toBe(7431.5);
  });
});
