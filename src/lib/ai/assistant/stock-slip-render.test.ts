import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { canonicalMarketLabel } from "@/lib/market";
import * as stockService from "@/lib/summary/stock-summary-service";
import { buildStockSummaryFromRows } from "@/lib/summary/stock-summary";
import { FakeDatabase } from "@/lib/summary/test-fake-supabase";
import { getMarketStockTool, getSlipStatusTool, getStockSummaryTool } from "@/lib/ai/readonly-tools";
import { createFixtureDataReader } from "./testing/fixture-data";
import { renderOperationalOutput } from "./financial-render";

const DATE = "2026-10-31";
const MARKET = canonicalMarketLabel("ราชพฤกษ์");
const client = (db = new FakeDatabase()) => db as unknown as SupabaseClient<Database>;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });

describe("authoritative stock rendering", () => {
  test("shows damaged returns separately and keeps mixed units separate", () => {
    const text = renderOperationalOutput({ tool: "get_market_stock", isComplete: true, markets: [{ market: MARKET, items: [
      { product: "มะม่วง", unit: "กก.", remainingForResaleQuantity: 6.5, damagedQuantity: 1.2 },
      { product: "มะม่วง", unit: "ลูก", remainingForResaleQuantity: 4, damagedQuantity: 1 },
    ] }] });
    expect(text).toContain("มะม่วง เหลือขายต่อ 6.5 กก. · คืนเสีย 1.2 กก.");
    expect(text).toContain("มะม่วง เหลือขายต่อ 4 ลูก · คืนเสีย 1 ลูก");
    expect(text).not.toContain("10.5");
    expect(text).not.toContain("7.7");
  });

  test("both stock tools preserve damaged-only rows and missing-data flags within scope", async () => {
    const summary = buildStockSummaryFromRows(DATE, [
      { market_name: MARKET, product_name: "มะม่วง", unit: "กก.", transaction_type: "เบิก", quantity: 10 },
      { market_name: MARKET, product_name: "มะม่วง", unit: "กก.", transaction_type: "คืนเสีย", quantity: 1.2 },
      { market_name: MARKET, product_name: "ส้มโอ", unit: "ลูก", transaction_type: "คืน", quantity: 4 },
      { market_name: "พาซิโอ้ผัก", product_name: "ผักกาด", unit: "กก.", transaction_type: "คืน", quantity: 99 },
    ]);
    spies.push(spyOn(stockService, "loadStockSummary").mockResolvedValue(summary));
    const scope = { markets: new Set([MARKET]) };
    const outputs = [await getStockSummaryTool(client(), DATE, scope), await getMarketStockTool(client(), DATE, MARKET, scope)];
    for (const output of outputs) {
      expect(output.markets).toHaveLength(1);
      expect(output.markets[0]!.items).toContainEqual(expect.objectContaining({
        product: "มะม่วง", damagedQuantity: 1.2, hasReturnGoodData: false, hasDamagedData: true,
      }));
      const text = renderOperationalOutput(output);
      expect(text).toContain("มะม่วง เหลือขายต่อ ไม่มีข้อมูล");
      expect(text).toContain("คืนเสีย 1.2");
      expect(text).toContain("ส้มโอ เหลือขายต่อ 4 ลูก · คืนเสีย ไม่มีข้อมูล ลูก");
      expect(text).toContain("ข้อมูลชั่งคืนยังไม่ครบ");
      expect(text).not.toContain("99");
      expect(text).not.toContain("คืนเสีย 0");
    }
  });

  test("null quantities remain unknown while recorded zeros remain zero", () => {
    const text = renderOperationalOutput({ tool: "get_stock_summary", markets: [{ market: MARKET, items: [
      { product: "ไม่ทราบ", unit: "กก.", remainingForResaleQuantity: null, damagedQuantity: null },
      { product: "บันทึกแล้ว", unit: "กก.", remainingForResaleQuantity: 0, damagedQuantity: 0, hasReturnGoodData: true, hasDamagedData: true },
    ] }] });
    expect(text).toContain("ไม่ทราบ เหลือขายต่อ ไม่มีข้อมูล กก. · คืนเสีย ไม่มีข้อมูล กก.");
    expect(text).toContain("บันทึกแล้ว เหลือขายต่อ 0 กก. · คืนเสีย 0 กก.");
  });
});

describe("authoritative slip rendering", () => {
  const batch = (successCount: number, review: number, processing: number) => ({
    seller: "เล็ก", market: MARKET, successCount,
    checkStatusCounts: { EXTRACTED: successCount + 1, PARTIAL_EXTRACTED: 1, NEED_REVIEW: review, FAILED: 1, PROCESSING: processing, NOT_CHECKED: 0 },
  });

  test("totals batch successes once, retaining separate OCR, review and processing counts", () => {
    const text = renderOperationalOutput({ tool: "get_slip_status", batches: [batch(7, 1, 1), batch(5, 0, 0)] });
    expect(text).toContain("รวม อ่านข้อมูลได้แล้ว 12 ใบ (ตามผลสรุปชุด)");
    expect(text).toContain("อ่านครบ 8 ใบ อ่านได้บางส่วน 1 ใบ");
    expect(text).toContain("ตรวจมือ 2 รายการ กำลังอ่าน 1 รายการ");
    expect(text).toContain("ตรวจมือ 1 รายการ กำลังอ่าน 0 รายการ");
    expect(text).toContain("ยังไม่ใช่การยืนยันจากธนาคาร");
    expect(text).not.toContain("ยืนยันจากธนาคารแล้ว 12");
    expect(text).not.toContain("รวม อ่านข้อมูลได้แล้ว 26");
  });

  test("uses actual tool success counters rather than reclassifying check statuses", async () => {
    const db = new FakeDatabase().seed("slip_batches", [{
      id: "b1", seller_name: "เล็ก", market_name: MARKET, slip_date: DATE, status: "review_needed",
      image_count: 3, success_count: 1, failed_count: 2, first_image_at: "2026-10-31T03:00:00Z",
    }]).seed("slip_evidences", [{ id: "e1", batch_id: "b1" }, { id: "e2", batch_id: "b1" }, { id: "e3", batch_id: "b1" }])
      .seed("slip_checks", [{ evidence_id: "e1", status: "EXTRACTED" }, { evidence_id: "e2", status: "EXTRACTED" }, { evidence_id: "e3", status: "PARTIAL_EXTRACTED" }]);
    const output = await getSlipStatusTool(client(db), DATE, { staff: null, market: null });
    const text = renderOperationalOutput(output);
    expect(text).toContain("รวม อ่านข้อมูลได้แล้ว 1 ใบ (ตามผลสรุปชุด)");
    expect(text).toContain("อ่านครบ 2 ใบ อ่านได้บางส่วน 1 ใบ");
    expect(text).not.toContain("รวม อ่านข้อมูลได้แล้ว 3");
  });

  test.each(["partial", "truncated"])("%s counts are explicitly limited to found data", flag => {
    const text = renderOperationalOutput({ tool: "get_slip_status", batches: [batch(7, 1, 1)], [flag]: true });
    expect(text).toContain("เฉพาะข้อมูลที่พบ อ่านข้อมูลได้แล้ว 7 ใบ");
    expect(text).toContain("ข้อมูลบางส่วน ยังสรุปทั้งหมดไม่ได้");
    expect(text).not.toContain("รวม อ่านข้อมูลได้แล้ว");
  });

  test("missing counts are unknown and empty results do not become zero successes", () => {
    const missing = renderOperationalOutput({ tool: "get_slip_status", batches: [{ seller: "เล็ก", market: MARKET, successCount: null }] });
    expect(missing).toContain("รวม อ่านข้อมูลได้แล้ว ไม่มีข้อมูล");
    expect(missing).toContain("ตรวจมือ ไม่มีข้อมูล");
    expect(missing).not.toContain(" 0 ");
    const empty = renderOperationalOutput({ tool: "get_slip_status", batches: [] });
    expect(empty).toContain("ไม่พบข้อมูลสลิป");
    expect(empty).toContain("ไม่มีข้อมูลการยืนยันจากธนาคาร");
    expect(empty).not.toContain(" 0 ");
  });
});

test("evaluation slip fixtures retain authoritative batch counters without changing expected totals", async () => {
  const output = await createFixtureDataReader()({tool: "get_slip_status", businessDate: DATE, staff: null, market: null}, {markets: null});
  expect(renderOperationalOutput(output)).toContain("รวม อ่านข้อมูลได้แล้ว 12 ใบ");
});
