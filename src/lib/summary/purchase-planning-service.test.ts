import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { HOUSE_STOCK_PRICED_PARSER_VERSION } from "@/lib/physical-inventory/types";
import { loadPurchasePlanningReport } from "./purchase-planning-service";
import { FakeDatabase, type Row } from "./test-fake-supabase";

const BUSINESS_DATE = "2026-08-21";
const ROUND = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function produceRow(overrides: Row = {}): Row {
  return {
    id: `item-${Math.random().toString(36).slice(2)}`,
    session_id: "session-1",
    market_name: "ตลาด72",
    staff_name: "โอม",
    product_name: "แอปเปิ้ล",
    quantity: 100,
    unit: "ลูก",
    transaction_type: "เบิก",
    base_transaction_type: "เบิก",
    price_per_unit: 20,
    raw_message_id: "raw-seed-1",
    session_kind: "main",
    item_created_at: "2026-08-21T02:00:00.000Z",
    accountability_round_id: ROUND,
    transaction_date: BUSINESS_DATE,
    ...overrides,
  };
}

function snapshotRow(overrides: Row = {}): Row {
  return {
    id: SNAPSHOT,
    business_date: BUSINESS_DATE,
    warehouse_code: "MAIN",
    status: "finalized",
    parser_version: HOUSE_STOCK_PRICED_PARSER_VERSION,
    replacement_snapshot_id: null,
    ...overrides,
  };
}

function cleanSession(totalItems: number): Row {
  return { id: "session-1", total_items: totalItems, parser_errors: [] };
}

function itemRow(overrides: Row = {}): Row {
  return {
    id: `stock-${Math.random().toString(36).slice(2)}`,
    snapshot_id: SNAPSHOT,
    item_ordinal: 1,
    raw_text: "แอปเปิ้ล 10 ลูก 20 บาท",
    raw_product_description: "แอปเปิ้ล",
    normalized_product: "แอปเปิ้ล",
    quantity: 10,
    unit_price_satang: 2_000,
    raw_unit: "ลูก",
    normalized_unit: "ลูก",
    resolution_status: "ACCEPTED_NORMALIZED",
    reason: null,
    ...overrides,
  };
}

/** 100 out, 20 weighed back → 80 sold → 80%, a HIGH seller. */
function highSellingDay(db = new FakeDatabase()): FakeDatabase {
  return db
    .seed("produce_transactions", [
      produceRow({ transaction_type: "เบิก", quantity: 100 }),
      produceRow({ transaction_type: "คืน", quantity: 20 }),
    ])
    .seed("accountability_rounds", [
      { id: ROUND, seller_label: "โอม", market_label: "ตลาด72" },
    ])
    .seed("produce_sessions", [cleanSession(2)]);
}

const client = (db: FakeDatabase): SupabaseClient<Database> =>
  db as unknown as SupabaseClient<Database>;

describe("P0 purchase planning return evidence", () => {
  const failedReturn = {
    id: "failed-return", session_generation: "generation-1", session_key: "group:g:user:u",
    source_id: "group-1", staff_label: "โอม", market_label: "ตลาด72",
    declared_transaction_type: "คืน", business_date: BUSINESS_DATE,
    accountability_round_id: null, finalization_status: "failed_closed",
    accumulated_text: "โอม-ตลาด72 ชั่งคืน 21/8/2569\n1.แอปเปิ้ล 20 ลูก\nจบรายการชั่งคืน",
    created_at: "2026-08-21T08:00:00.000Z", generation_created_at: "2026-08-21T08:00:00.000Z",
  };
  function withdrawalDay() {
    return new FakeDatabase()
      .seed("produce_transactions", [produceRow()])
      .seed("accountability_rounds", [{ id: ROUND, source_id: "group-1", business_date: BUSINESS_DATE,
        seller_label: "โอม", market_label: "ตลาด72" }])
      .seed("produce_sessions", [cleanSession(1)]);
  }
  test.each(["pending_sessions", "pending_session_retired_generations"])("%s unbound return leaves sold quantity unknown", async (table) => {
    const db = withdrawalDay().seed(table, [failedReturn]);
    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);
    expect(report.items[0]!.estimatedSoldQuantity).toBeNull();
    expect(report.items[0]!.uncertaintyReasons).toContain("return_incomplete");
    expect(db.appendCalls).toBe(0);
  });
  test("a later proven resend clears the retired return in planning", async () => {
    const db = withdrawalDay().seed("pending_session_retired_generations", [failedReturn])
      .seed("produce_transactions", [produceRow(), produceRow({ id: "returned", session_id: "resend",
        transaction_type: "คืน", base_transaction_type: "คืน", quantity: 20, raw_message_id: "raw-resend" })])
      .seed("produce_sessions", [cleanSession(1), { id: "resend", total_items: 1, parser_errors: [],
        session_date: BUSINESS_DATE, session_kind: "main", staff_name: "โอม", session_title: "ตลาด72",
        accountability_round_id: ROUND, raw_message_id: "raw-resend", finalized_at: "2026-08-21T09:00:00.000Z" }])
      .seed("raw_messages", [{ id: "raw-resend", source_id: "group-1" }]);
    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);
    expect(report.unresolvedSessionCount).toBe(0);
    expect(report.items[0]!.estimatedSoldQuantity).toBe(80);
  });
});

describe("loadPurchasePlanningReport — house stock wiring", () => {
  test("a matched authoritative snapshot turns a high seller green", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [itemRow({ quantity: 10 })]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.stockAbsence).toBeNull();
    expect(report.items).toHaveLength(1);
    expect(report.items[0]!.houseStockQuantity).toBe(10);
    // 10 left at home after dispatch + 20 that came back good = 30 ready.
    expect(report.items[0]!.nextDayGoodStockQuantity).toBe(30);
    expect(report.items[0]!.nextStockToSoldRatio).toBe(30 / 80);
    expect(report.items[0]!.status).toBe("strong");
  });

  test("a large house stock holds the same high seller back to 🟠", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [itemRow({ quantity: 200 })]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.items[0]!.houseStockQuantity).toBe(200);
    expect(report.items[0]!.nextDayGoodStockQuantity).toBe(220);
    expect(report.items[0]!.status).toBe("surplus");
    // The market arithmetic is untouched by the snapshot.
    expect(report.items[0]!.goodReturnQuantity).toBe(20);
    expect(report.items[0]!.estimatedSoldQuantity).toBe(80);
  });

  test("rejected observations are not counted as stock", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [
        itemRow({ quantity: 10 }),
        itemRow({ quantity: 999, resolution_status: "REJECTED", reason: "missing_unit" }),
      ]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);
    expect(report.items[0]!.houseStockQuantity).toBe(10);
  });

  test("no snapshot leaves the market report intact and the seller conservative", async () => {
    const report = await loadPurchasePlanningReport(client(highSellingDay()), BUSINESS_DATE);

    expect(report.stockAbsence).toBe("no_snapshot");
    expect(report.items[0]!.estimatedSoldQuantity).toBe(80);
    expect(report.items[0]!.houseStockQuantity).toBeNull();
    expect(report.items[0]!.status).toBe("surplus");
  });

  test("two authoritative snapshots invent no stock and do not fail the report", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [
        snapshotRow(),
        snapshotRow({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      ])
      .seed("physical_inventory_items", [itemRow({ quantity: 10 })]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.stockAbsence).toBe("snapshot_conflict");
    expect(report.items[0]!.houseStockQuantity).toBeNull();
    expect(report.items[0]!.status).toBe("surplus");
  });

  test("a superseded or unfinalized snapshot is not authoritative", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [
        snapshotRow({ status: "open" }),
        snapshotRow({
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          replacement_snapshot_id: SNAPSHOT,
        }),
      ])
      .seed("physical_inventory_items", [itemRow({ quantity: 10 })]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);
    expect(report.stockAbsence).toBe("no_snapshot");
  });

  test("a house unit the market never uses is never combined", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [
        itemRow({ quantity: 10, normalized_unit: null, raw_unit: "ตะกร้า" }),
      ]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.stockAbsence).toBeNull();
    expect(report.items[0]!.houseStockQuantity).toBeNull();
    expect(report.items[0]!.stockAbsence).toBe("no_match");
    expect(report.items[0]!.status).toBe("surplus");
  });

  test("a snapshot whose accepted entries are empty is a complete zero count", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [
        itemRow({ quantity: 5, resolution_status: "REJECTED", reason: "missing_unit_price" }),
      ]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.stockAbsence).toBeNull();
    expect(report.items[0]!.houseStockQuantity).toBe(0);
    expect(report.items[0]!.nextDayGoodStockQuantity).toBe(20);
    expect(report.items[0]!.status).toBe("strong");
  });

  test("an authoritative snapshot with zero item rows is known zero, not missing", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", []);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.stockAbsence).toBeNull();
    expect(report.items[0]!.houseStockQuantity).toBe(0);
    expect(report.items[0]!.stockAbsence).toBeNull();
    expect(report.items[0]!.nextDayGoodStockQuantity).toBe(20);
    expect(report.items[0]!.status).toBe("strong");
  });

  test("pineapple absent from the complete 21/08-shaped snapshot is 🟢", async () => {
    const db = new FakeDatabase()
      .seed("produce_transactions", [
        produceRow({
          product_name: "สับปะรด",
          unit: "ถุง",
          transaction_type: "เบิก",
          quantity: 34,
        }),
        produceRow({
          product_name: "สับปะรด",
          unit: "ถุง",
          transaction_type: "คืน",
          quantity: 10,
        }),
      ])
      .seed("accountability_rounds", [
        { id: ROUND, seller_label: "โอม", market_label: "ตลาด72" },
      ])
      .seed("produce_sessions", [cleanSession(2)])
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [
        itemRow({
          raw_product_description: "ลูกพลับ",
          normalized_product: "ลูกพลับ",
          quantity: 230,
          raw_unit: "ลูก",
          normalized_unit: "ลูก",
        }),
        itemRow({
          raw_product_description: "สาลี่",
          normalized_product: "สาลี่",
          quantity: 216,
          raw_unit: "ลูก",
          normalized_unit: "ลูก",
        }),
      ]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);
    const pineapple = report.items[0]!;

    expect(pineapple.productName).toBe("สับปะรด");
    expect(pineapple.houseStockQuantity).toBe(0);
    expect(pineapple.nextDayGoodStockQuantity).toBe(10);
    expect(pineapple.nextStockToSoldRatio).toBeCloseTo(10 / 24, 6);
    expect(pineapple.status).toBe("strong");
  });

  test("a session that failed to parse blocks its own products", async () => {
    const db = highSellingDay()
      .seed("produce_sessions", [
        { id: "session-1", total_items: 2, parser_errors: [{ line: 3, reason: "unreadable" }] },
      ]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.items[0]!.status).toBe("unknown");
    expect(report.items[0]!.uncertaintyReasons).toContain("session_integrity");
  });

  test("a session that persisted fewer rows than it claimed blocks its products", async () => {
    const db = highSellingDay()
      .seed("produce_sessions", [
        { id: "session-1", total_items: 5, parser_errors: [] },
      ]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.items[0]!.status).toBe("unknown");
    expect(report.items[0]!.uncertaintyReasons).toContain("session_integrity");
  });

  test("a clean session is not blocked", async () => {
    const db = highSellingDay()
      .seed("produce_sessions", [
        { id: "session-1", total_items: 2, parser_errors: [] },
      ])
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [itemRow({ quantity: 10 })]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.items[0]!.uncertaintyReasons).toEqual([]);
    expect(report.items[0]!.status).toBe("strong");
  });

  test("the legacy เสีย spelling survives the loader's lack of a type filter", async () => {
    const db = new FakeDatabase()
      .seed("produce_transactions", [
        produceRow({ transaction_type: "เบิก", quantity: 100 }),
        produceRow({ transaction_type: "คืน", quantity: 20 }),
        produceRow({ transaction_type: "เสีย", quantity: 30 }),
      ])
      .seed("accountability_rounds", [
        { id: ROUND, seller_label: "โอม", market_label: "ตลาด72" },
      ])
      .seed("produce_sessions", [cleanSession(3)]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.items[0]!.damagedQuantity).toBe(30);
    expect(report.items[0]!.estimatedSoldQuantity).toBe(50);
  });

  test("a missing produce_sessions row fails closed instead of ranking", async () => {
    // Same HIGH + low-house numbers that turn green when metadata is present.
    // produce_sessions is unseeded, so the lookup returns [] — not an error.
    const db = new FakeDatabase()
      .seed("produce_transactions", [
        produceRow({ transaction_type: "เบิก", quantity: 100 }),
        produceRow({ transaction_type: "คืน", quantity: 20 }),
      ])
      .seed("accountability_rounds", [
        { id: ROUND, seller_label: "โอม", market_label: "ตลาด72" },
      ])
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [itemRow({ quantity: 10 })]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.items[0]!.status).toBe("unknown");
    expect(report.items[0]!.uncertaintyReasons).toContain("session_integrity");
    expect(report.items[0]!.band).toBeNull();
    expect(report.items[0]!.status).not.toBe("strong");
  });
});

describe("loadPurchasePlanningReport — unattributable withdrawal wiring", () => {
  const TARGET_MS = Date.parse("2026-08-21T06:00:00.000Z");
  const OTHER_DAY_MS = Date.parse("2026-08-20T06:00:00.000Z");

  test("an item-only rejected เบิก poisons only the named product", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [itemRow({ quantity: 10 })])
      .seed("pending_produce_deferred_events", [{
        raw_message_id: "raw-unbound-withdraw",
        source_id: "Csource",
        raw_text: "1.ทับทิม25บาท\n26ลูก",
        line_timestamp_ms: TARGET_MS,
        status: "rejected_after_close",
      }]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);
    const apple = report.items.find((item) => item.productName === "แอปเปิ้ล")!;
    const pomegranate = report.items.find((item) => item.productName === "ทับทิม")!;

    expect(report.unresolvedSessionCount).toBe(1);
    expect(report.unresolvedSessionCounts).toEqual({
      withdrawal: 1,
      goodReturn: 0,
      damagedReturn: 0,
      unknown: 0,
    });
    expect(report.unsafeReportReason).toBeNull();
    expect(apple.status).toBe("strong");
    expect(apple.uncertaintyReasons).not.toContain("unattributable_withdrawal");
    expect(pomegranate.status).toBe("unknown");
    expect(pomegranate.uncertaintyReasons).toContain("unattributable_withdrawal");
  });

  test("an unresolved คืน does not mark products unattributable_withdrawal", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [itemRow({ quantity: 10 })])
      .seed("pending_produce_deferred_events", [{
        raw_message_id: "raw-unbound-return",
        source_id: "Csource",
        raw_text: ["โอม-ตลาด72 คืน 21/8/2569", "1.แอปเปิ้ล10บาท", "5ลูก", "จบรายการคืน"].join("\n"),
        line_timestamp_ms: TARGET_MS,
        status: "rejected_after_close",
      }]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.unresolvedSessionCount).toBe(1);
    expect(report.unresolvedSessionCounts).toEqual({
      withdrawal: 0,
      goodReturn: 1,
      damagedReturn: 0,
      unknown: 0,
    });
    expect(report.items[0]!.uncertaintyReasons).not.toContain("unattributable_withdrawal");
    expect(report.items[0]!.status).not.toBe("unknown");
  });

  test("a rejected เบิก on another business date does not poison today's report", async () => {
    const db = highSellingDay()
      .seed("physical_inventory_snapshots", [snapshotRow()])
      .seed("physical_inventory_items", [itemRow({ quantity: 10 })])
      .seed("pending_produce_deferred_events", [{
        raw_message_id: "raw-other-day",
        source_id: "Csource",
        raw_text: "1.ทับทิม25บาท\n26ลูก",
        line_timestamp_ms: OTHER_DAY_MS,
        status: "rejected_after_close",
      }]);

    const report = await loadPurchasePlanningReport(client(db), BUSINESS_DATE);

    expect(report.unresolvedSessionCount).toBe(0);
    expect(report.unresolvedSessionCounts).toEqual({
      withdrawal: 0,
      goodReturn: 0,
      damagedReturn: 0,
      unknown: 0,
    });
    expect(report.unsafeReportReason).toBeNull();
    expect(report.items).toHaveLength(1);
    expect(report.items[0]!.productName).toBe("แอปเปิ้ล");
    expect(report.items[0]!.status).toBe("strong");
  });
});
