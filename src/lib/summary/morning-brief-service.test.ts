import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { HOUSE_STOCK_PRICED_PARSER_VERSION } from "@/lib/physical-inventory/types";
import {
  preloadRuntimeProductCodes,
  resetRuntimeProductCodesForTests,
  runtimeProductCodeEntryForName,
} from "@/lib/produce/product-code/resolver";
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
  beforeEach(() => resetRuntimeProductCodesForTests());
  afterEach(() => resetRuntimeProductCodesForTests());

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

  function runtimeOnlyFruitDatabase(productName: string) {
    return new FakeDatabase()
      .seed("produce_product_codes", [{
        product_code: "ม98",
        category_code: "ม",
        category_name: "ผลไม้",
        canonical_name: productName,
        code_enabled: true,
      }])
      .seed("produce_transactions", [{
        id: "transaction-1",
        transaction_date: BUSINESS_DATE,
        session_id: "session-1",
        market_name: "ตลาดเอ",
        product_name: productName,
        quantity: 10,
        unit: "กก.",
        transaction_type: "เบิก",
        base_transaction_type: "เบิก",
        price_per_unit: 100,
        basis_quantity: null,
        basis_unit: null,
        basis_price: null,
        raw_message_id: "raw-1",
        session_kind: "main",
        item_created_at: "2026-08-27T02:00:00.000Z",
        accountability_round_id: null,
      }])
      .seed("raw_messages", [{
        id: "raw-1",
        source_id: "source-1",
        raw_text: "",
        payload: null,
        created_at: "2026-08-27T02:00:00.000Z",
        is_processed: true,
        message_type: "text",
      }])
      .seed("produce_sessions", [{
        id: "session-1",
        session_date: BUSINESS_DATE,
        session_title: "ตลาดเอ",
        total_items: 1,
        parser_errors: [],
        raw_message_id: "raw-1",
        voided_at: null,
      }]);
  }

  test("includes a runtime-only promoted fruit in fruitFinancial", async () => {
    const productName = "runtime-only promoted fruit";

    const report = await loadMorningBriefReport(client(runtimeOnlyFruitDatabase(productName)), BUSINESS_DATE);

    expect(report.fruitFinancial).toEqual({
      withdrawalValueSatang: 100_000,
      salesValueSatang: 100_000,
      goodReturnValueSatang: 0,
      houseStockValueSatang: null,
      readyValueSatang: null,
      markets: [{
        marketLabel: "ตลาดเอ",
        withdrawalValueSatang: 100_000,
        salesValueSatang: 100_000,
        goodReturnValueSatang: 0,
      }],
    });
  });

  test("keeps its own dictionary snapshot when another request's refresh fails mid-load", async () => {
    const productName = "runtime-only promoted fruit";
    const db = runtimeOnlyFruitDatabase(productName);
    let refresh: Promise<unknown> | null = null;
    const racing = {
      rpc: db.rpc.bind(db),
      from(table: string) {
        // Request B refreshes once this report's own preload is done and its
        // loaders are reading, and fails closed.
        if (!refresh && table !== "produce_product_codes") {
          refresh = preloadRuntimeProductCodes({ from: () => { throw new Error("request B read failed"); } });
        }
        return db.from(table);
      },
    };

    const report = await loadMorningBriefReport(racing as unknown as SupabaseClient<Database>, BUSINESS_DATE);
    await refresh;

    expect(report.fruitFinancial?.withdrawalValueSatang).toBe(100_000);
    expect(runtimeProductCodeEntryForName(productName)).toBeNull();
  });
});
