import { describe, expect, it } from "bun:test";
import { buildReportGroups, reportGroupKey, type ReportRow } from "./report";

const row = (overrides: Partial<ReportRow>): ReportRow => ({
  transaction_date: "2026-10-07",
  market_name: "ราชพฤกษ์",
  staff_name: "น้อย",
  product_name: "มะนาว",
  quantity: 10,
  unit: "โล",
  price_per_unit: 50,
  total_amount: 500,
  transaction_type: "เบิก",
  item_number: 1,
  basis_quantity: null,
  basis_unit: null,
  basis_price: null,
  ...overrides,
});

describe("P0: report groups carry the server's ชั่งคืน verdict", () => {
  const rows = [row({}), row({ staff_name: "แดง", market_name: "ตลาดไท" })];

  it("only the named group is provisional", () => {
    const key = reportGroupKey({ date: "2026-10-07", market: "ราชพฤกษ์", seller: "น้อย" });
    const groups = buildReportGroups(rows, {}, [key]);
    expect(groups.find((g) => g.seller === "น้อย")?.provisional).toBe(true);
    expect(groups.find((g) => g.seller === "แดง")?.provisional).toBe(false);
  });

  it("the key matches the group identity the page and PDF render", () => {
    const [group] = buildReportGroups([row({})], {});
    expect(reportGroupKey(group)).toBe("2026-10-07||ราชพฤกษ์||น้อย");
  });
});
