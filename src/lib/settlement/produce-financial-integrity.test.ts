import { describe, expect, it } from "bun:test";
import { produceFinancialIntegrity } from "./produce-financial-integrity";

const row = (
  transaction_type: string,
  quantity: number,
  price_per_unit: number,
  product_name = "มังคุด",
  unit = "โล",
) => ({ product_name, unit, quantity, price_per_unit, transaction_type });

describe("produceFinancialIntegrity", () => {
  it("flags quantity excess even when lower return pricing keeps money net positive", () => {
    expect(produceFinancialIntegrity([
      row("เบิก", 10, 100),
      row("คืน", 11, 10),
    ])).toBe("returns_exceed_withdrawal");
  });

  it("flags a return with no withdrawal", () => {
    expect(produceFinancialIntegrity([
      row("คืน", 1, 50),
    ])).toBe("returns_exceed_withdrawal");
  });

  it("keeps exact and normal quantity arithmetic trusted", () => {
    expect(produceFinancialIntegrity([
      row("เบิก", 10, 100),
      row("คืน", 7, 100),
      row("คืนเสีย", 3, 100),
    ])).toBe("trusted");
  });
});
