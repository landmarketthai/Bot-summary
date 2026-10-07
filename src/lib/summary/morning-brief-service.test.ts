import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { HOUSE_STOCK_PRICED_PARSER_VERSION } from "@/lib/physical-inventory/types";
import { FakeDatabase } from "./test-fake-supabase";
import { loadMorningBriefReport } from "./morning-brief-service";

const BUSINESS_DATE = "2026-08-27";

const client = (db: FakeDatabase): SupabaseClient<Database> =>
  db as unknown as SupabaseClient<Database>;

function snapshot(id: string) {
  return {
    id,
    business_date: BUSINESS_DATE,
    warehouse_code: "MAIN",
    status: "finalized",
    parser_version: HOUSE_STOCK_PRICED_PARSER_VERSION,
    replacement_snapshot_id: null,
  };
}

describe("loadMorningBriefReport", () => {
  test("loads compact purchase and sales summaries while House Stock is missing", async () => {
    const report = await loadMorningBriefReport(client(new FakeDatabase()), BUSINESS_DATE);

    expect(report.businessDate).toBe(BUSINESS_DATE);
    expect(report.purchasePlanning).toEqual({
      strong: { count: 0, productNames: [], items: [] },
      surplus: { count: 0, productNames: [], items: [] },
      reduce: { count: 0, productNames: [], items: [] },
      unknown: { count: 0, productNames: [], items: [] },
    });
    expect(report.sales).toMatchObject({
      confirmedSalesSatang: 0,
      valueAuthoritative: true,
      trustedCount: 0,
      unresolvedCount: 0,
    });
    expect(report.houseStock).toEqual({ status: "missing" });
    expect(report.whiteSheetStatus).toBe("missing");
    expect(report.produceFinancial).toEqual({});
    expect(report.fruitFinancial).toBeUndefined();
  });

  test("treats a zero-baht white sheet as entered, not missing", async () => {
    const db = new FakeDatabase().seed("digital_white_sheet_cash_entries", [
      { business_date: BUSINESS_DATE, white_sheet_sales: 0 },
    ]);

    const report = await loadMorningBriefReport(client(db), BUSINESS_DATE);

    expect(report.whiteSheetStatus).toBe("entered");
  });

  test("treats a null white-sheet sales value as not entered", async () => {
    const db = new FakeDatabase().seed("digital_white_sheet_cash_entries", [
      { business_date: BUSINESS_DATE, white_sheet_sales: null },
    ]);

    const report = await loadMorningBriefReport(client(db), BUSINESS_DATE);

    expect(report.whiteSheetStatus).toBe("missing");
  });

  test("loads authoritative House Stock group count and value", async () => {
    const db = new FakeDatabase()
      .seed("physical_inventory_snapshots", [snapshot("stock-1")])
      .seed("physical_inventory_items", [
        {
          snapshot_id: "stock-1",
          item_ordinal: 1,
          normalized_product: "มะม่วง",
          raw_product_description: "มะม่วง",
          normalized_unit: "กก.",
          raw_unit: "กก.",
          quantity: 2,
          unit_price_satang: 15_600,
          raw_text: "มะม่วง 2 กก. 156 บาท",
          resolution_status: "AUTO_RESOLVED",
        },
      ]);

    const report = await loadMorningBriefReport(client(db), BUSINESS_DATE);

    expect(report.houseStock).toEqual({
      status: "available",
      groupCount: 1,
      totalValueSatang: 31_200,
      items: [{ productName: "มะม่วง", category: "ผลไม้", unit: "กก.", quantity: 2, unitPriceSatang: 15_600, valueSatang: 31_200 }],
    });
  });

  test("house-only sections are explicit and empty fruit is hidden", async () => {
    const db = new FakeDatabase()
      .seed("physical_inventory_snapshots", [snapshot("stock-sections")])
      .seed("physical_inventory_items", ["เห็ดนางฟ้า", "หมอนทอง", "ปลาทู", "สินค้าใหม่"].map((name, index) => ({
        snapshot_id: "stock-sections", item_ordinal: index + 1,
        normalized_product: name, raw_product_description: name,
        normalized_unit: "โล", raw_unit: "โล", quantity: 2,
        unit_price_satang: 100, raw_text: name + " 2 โล 1 บาท", resolution_status: "AUTO_RESOLVED",
      })));
    const report = await loadMorningBriefReport(client(db), BUSINESS_DATE);
    expect(Object.keys(report.produceFinancial!)).toEqual(["vegetable", "other"]);
    expect(report.fruitFinancial).toBeUndefined();
    expect(report.produceFinancial?.vegetable).toMatchObject({ houseStockValueSatang: 200, readyValueSatang: 200, markets: [] });
    expect(report.produceFinancial?.other).toMatchObject({ houseStockValueSatang: 600, readyValueSatang: 600, markets: [] });
    expect(report.houseStock.status === "available" && report.houseStock.items?.find((item) => item.productName === "เห็ดนางฟ้า")?.category)
      .not.toBe("ไม่ระบุหมวด");
  });

  test("conflicting House Stock snapshots do not blank purchase or sales sections", async () => {
    const db = new FakeDatabase().seed("physical_inventory_snapshots", [
      snapshot("stock-1"),
      snapshot("stock-2"),
    ]);

    const report = await loadMorningBriefReport(client(db), BUSINESS_DATE);

    expect(report.houseStock).toEqual({ status: "unavailable" });
    expect(report.purchasePlanning.unknown.count).toBe(0);
    expect(report.sales.confirmedSalesSatang).toBe(0);
  });

  test("loads reconciliation totals for the Morning Brief PDF", async () => {
    const db = new FakeDatabase()
      .seed("transfer_reconciliations", [{
        source_id: "group-a", business_date: BUSINESS_DATE, ai_verified_total: 900, manual_slip_total: 50,
        checked_slip_total: 950, submitted_transfer_total: 1000, difference: 50, matched: false,
      }])
      .seed("settlement_entries", [{ source_id: "group-a", settlement_date: BUSINESS_DATE, market_name: "Market A" }]);

    const report = await loadMorningBriefReport(client(db), BUSINESS_DATE);

    expect(report.reconciliation).toEqual({
      status: "available", submittedTransferBaht: 1000, checkedSlipBaht: 950, differenceBaht: 50, needsReviewCount: 1,
      rows: [{ market: "Market A", submittedTransferBaht: 1000, checkedSlipBaht: 950, differenceBaht: 50, status: "transfer_over" }],
    });
  });
});
