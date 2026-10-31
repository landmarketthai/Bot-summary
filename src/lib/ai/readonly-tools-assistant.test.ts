import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { canonicalMarketLabel } from "@/lib/market";
import * as salesLoad from "@/lib/sales/load";
import { FakeDatabase } from "@/lib/summary/test-fake-supabase";
import {
  getDailySummaryTool,
  getPendingItemsTool,
  getSlipStatusTool,
  getStaffProduceTool,
  getWhiteSheetStatusTool,
  normalizeStaffName,
  type ToolDataScope,
} from "./readonly-tools";

const DATE = "2026-10-31";
const PASEO = canonicalMarketLabel("พาซิโอ้ผัก");
const RATCHA = canonicalMarketLabel("ราชพฤกษ์");
const onlyPaseo: ToolDataScope = { markets: new Set([PASEO]) };

function client(db: FakeDatabase): SupabaseClient<Database> {
  return db as unknown as SupabaseClient<Database>;
}

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });

describe("staff name matching", () => {
  test("polite prefixes are dropped only when a name remains", () => {
    expect(normalizeStaffName("หนูเล็ก")).toBe("เล็ก");
    expect(normalizeStaffName("พี่ ดำ")).toBe("ดำ");
    expect(normalizeStaffName("พี่")).toBe("พี่");
  });
});

describe("get_slip_status", () => {
  function seed() {
    return new FakeDatabase()
      .seed("slip_batches", [
        { id: "b1", seller_name: "เล็ก", market_name: "พาซิโอ้ผัก", slip_date: DATE, status: "review_needed", image_count: 4, success_count: 2, failed_count: 1, first_image_at: "2026-10-31T03:00:00Z" },
        { id: "b2", seller_name: "ดำ", market_name: "ราชพฤกษ์", slip_date: DATE, status: "completed", image_count: 2, success_count: 2, failed_count: 0, first_image_at: "2026-10-31T04:00:00Z" },
        { id: "b3", seller_name: "เล็ก", market_name: "พาซิโอ้ผัก", slip_date: null, status: "collecting", image_count: 1, success_count: 0, failed_count: 0, first_image_at: "2026-10-31T05:00:00Z" },
        { id: "b4", seller_name: "เล็ก", market_name: "พาซิโอ้ผัก", slip_date: "2026-10-30", status: "completed", image_count: 9, success_count: 9, failed_count: 0, first_image_at: "2026-10-30T05:00:00Z" },
      ])
      .seed("slip_evidences", [
        { id: "e1", batch_id: "b1" }, { id: "e2", batch_id: "b1" }, { id: "e3", batch_id: "b1" }, { id: "e4", batch_id: "b1" },
        { id: "e5", batch_id: "b2" }, { id: "e6", batch_id: "b3" }, { id: "e7", batch_id: "b4" },
      ])
      .seed("slip_checks", [
        { evidence_id: "e1", status: "NEED_REVIEW" }, { evidence_id: "e2", status: "FAILED" },
        { evidence_id: "e3", status: "EXTRACTED" }, { evidence_id: "e5", status: "EXTRACTED" },
        { evidence_id: "e6", status: "PROCESSING" }, { evidence_id: "e7", status: "NEED_REVIEW" },
      ]);
  }

  test("counts stored check statuses per batch for the staff member, including undated batches of the day", async () => {
    const result = await getSlipStatusTool(client(seed()), DATE, { staff: "หนูเล็ก", market: null });
    expect(result.batches.map((batch) => batch.batchStatus).sort()).toEqual(["collecting", "review_needed"]);
    const reviewNeeded = result.batches.find((batch) => batch.batchStatus === "review_needed")!;
    expect(reviewNeeded.checkStatusCounts).toMatchObject({ NEED_REVIEW: 1, FAILED: 1, EXTRACTED: 1, NOT_CHECKED: 1 });
    expect(reviewNeeded).toMatchObject({ imageCount: 4, successCount: 2, failedCount: 1, market: PASEO });
  });

  test("a market scope drops other markets at the source", async () => {
    const result = await getSlipStatusTool(client(seed()), DATE, { staff: null, market: null }, onlyPaseo);
    expect(result.batches.every((batch) => batch.market === PASEO)).toBe(true);
    expect(result.batches.some((batch) => batch.seller === "ดำ")).toBe(false);
  });
});

describe("get_staff_produce", () => {
  test("lists recorded lines per document for the staff member without summing", async () => {
    const row = (id: string, session: string, staff: string, market: string, kind: string, product: string, quantity: number) => ({
      id, session_id: session, staff_name: staff, market_name: market, product_name: product, quantity, unit: "กก.",
      transaction_type: kind, base_transaction_type: kind, session_kind: "main", transaction_date: DATE,
      item_created_at: `2026-10-31T0${id.length}:00:00Z`, raw_message_id: `raw-${session}`,
    });
    const db = new FakeDatabase().seed("produce_transactions", [
      row("1", "s1", "ดำ", "ราชพฤกษ์", "เบิก", "มะม่วง", 30),
      row("2", "s1", "ดำ", "ราชพฤกษ์", "เบิก", "ส้มโอ", 20),
      row("3", "s2", "พี่ดำ", "ราชพฤกษ์", "ชั่งคืน", "มะม่วง", 6.5),
      row("4", "s3", "ขวัญ", "พาซิโอ้ผัก", "เบิก", "ผักกาด", 15),
    ]);
    const result = await getStaffProduceTool(client(db), DATE, "พี่ดำ");
    expect(result.documentCount).toBe(2);
    expect(result.documents.map((document) => document.transactionType)).toEqual(["เบิก", "ชั่งคืน"]);
    expect(result.documents[0]!.items).toEqual([
      { product: "มะม่วง", quantity: 30, unit: "กก." },
      { product: "ส้มโอ", quantity: 20, unit: "กก." },
    ]);
    expect(JSON.stringify(result)).not.toContain("ผักกาด");

    const scoped = await getStaffProduceTool(client(db), DATE, "ดำ", onlyPaseo);
    expect(scoped.found).toBe(false);
  });
});

describe("get_white_sheet_status", () => {
  test("reports existence, finalization and entered flags, never amounts", async () => {
    const db = new FakeDatabase().seed("digital_white_sheet_cash_entries", [
      { business_date: DATE, market_label_normalized: "พาซิโอ้ผัก", finalized_at: null, white_sheet_sales: 18450.5, actual_cash_submitted: 9876.25, labor_entered: true, location_fee_entered: true, bag_entered: false, snack_entered: false, other_entered: false, actual_cash_submitted_entered: true },
      { business_date: DATE, market_label_normalized: "ราชพฤกษ์", finalized_at: "2026-10-31T12:00:00Z", white_sheet_sales: null, actual_cash_submitted: 0, labor_entered: false, location_fee_entered: false, bag_entered: false, snack_entered: false, other_entered: false, actual_cash_submitted_entered: false },
    ]);
    const result = await getWhiteSheetStatusTool(client(db), DATE, null);
    expect(result.sheets).toHaveLength(2);
    expect(result.sheets.find((sheet) => sheet.market === PASEO)).toMatchObject({ finalized: false, whiteSheetSalesEntered: true });
    expect(JSON.stringify(result)).not.toContain("9876.25");
    expect(JSON.stringify(result)).not.toContain("18450.5");
    expect((await getWhiteSheetStatusTool(client(db), DATE, null, onlyPaseo)).sheets.map((sheet) => sheet.market)).toEqual([PASEO]);
  });
});

describe("market scope reaches the authoritative calculators", () => {
  test("daily summary passes a market filter to loadSalesReport instead of re-deriving totals", async () => {
    const calls: Array<salesLoad.LoadSalesReportOptions | undefined> = [];
    spies.push(spyOn(salesLoad, "loadSalesReport").mockImplementation(async (_supabase, businessDate, options) => {
      calls.push(options);
      return {
        businessDate,
        allMarkets: { expectedSalesSatang: 100, pendingReviewSalesSatang: 0, totalSalesSatang: 100, adjustmentSatang: 0, quantityAuthoritative: true, valueAuthoritative: true, trustedRowCount: 1, valueBlockedRowCount: 0, quantityBlockedRowCount: 0 },
        markets: [],
        blocked: [],
        scopeBlockers: [],
      } as unknown as Awaited<ReturnType<typeof salesLoad.loadSalesReport>>;
    }));
    const unrestricted = await getDailySummaryTool(client(new FakeDatabase()), DATE);
    const scoped = await getDailySummaryTool(client(new FakeDatabase()), DATE, onlyPaseo);
    expect(calls[0]?.marketFilter).toBeUndefined();
    expect(unrestricted.totalScope).toBe("all_markets");
    expect(scoped.totalScope).toBe("permitted_markets_only");
    const filter = calls[1]!.marketFilter!;
    expect(filter("พาซิโอ้ผัก")).toBe(true);
    expect(filter("ราชพฤกษ์")).toBe(false);
    expect(filter(null)).toBe(false);
  });

  test("pending items filter by staff, market and scope", async () => {
    const attempt = (attemptId: string, staffLabel: string | null, marketLabel: string | null) => ({
      attemptId, origin: "pending_session" as const, businessDate: DATE, sourceId: "C", staffLabel, marketLabel,
      transactionKind: "เบิก" as const, accountabilityRoundId: null, attemptedAtMs: 1,
    });
    spies.push(spyOn(salesLoad, "loadProduceFailureScan").mockImplementation(async () => ({
      attempts: [attempt("a1", "ปลา", "วัดตะกล่ำ"), attempt("a2", "ขวัญ", "พาซิโอ้ผัก"), attempt("a3", "ขวัญ", null), attempt("a4", "ขวัญ", "ราชพฤกษ์")],
      classifications: [],
      activeIds: new Set(["a1", "a2", "a3", "a4"]),
      evidence: {} as never,
      lostMessages: [],
    })));
    const db = client(new FakeDatabase());
    expect((await getPendingItemsTool(db, DATE, { staff: "พี่ปลา" })).items.map((item) => item.attemptId)).toEqual(["a1"]);
    expect((await getPendingItemsTool(db, DATE, { staff: "ขวัญ" })).items.map((item) => item.attemptId)).toEqual(["a2", "a3", "a4"]);
    expect((await getPendingItemsTool(db, DATE, { staff: "ขวัญ", market: "ราชพฤกษ์" })).items.map((item) => item.attemptId)).toEqual(["a4"]);
    // A document without a market cannot be proven inside a restricted scope.
    expect((await getPendingItemsTool(db, DATE, { staff: "ขวัญ" }, onlyPaseo)).items.map((item) => item.attemptId)).toEqual(["a2"]);
    expect(RATCHA).toBeTruthy();
  });
});
