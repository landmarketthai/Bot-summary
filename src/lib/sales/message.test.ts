import { describe, expect, test } from "bun:test";
import { centralPriceMapKey } from "@/lib/white-sheet/pricing";
import { LINE_MESSAGE_MAX_CODE_POINTS } from "@/lib/summary/line-chunking";
import {
  LATEST_DATA_UNAVAILABLE_NOTICE,
  type LatestDataLookup,
} from "@/lib/summary/latest-data-hint";
import { calculateSalesReport, type SalesSourceRow } from "./calculate";
import {
  salesAutoNeedsLatestDataHint,
  SALES_NO_DATA_PREFIX,
  SALES_NO_HISTORY_NOTICE,
  buildSalesAutoBlocks,
  buildSalesAutoMessages,
  buildSalesSummaryBlocks,
  buildSalesSummaryMessages,
  groupMarketsByLabel,
  SALES_AUTO_TITLE,
  SALES_BLOCKED_HEADING,
  SALES_EMPTY_NOTICE,
  SALES_MANUAL_TITLE,
  SALES_OVERFLOW_NOTICE,
  SALES_NO_RETURN_ROW_LABEL,
  SALES_NO_ROWS_BLOCKED_NOTICE,
  SALES_MARKET_SECTION_HEADING,
  SALES_MARKET_PARTIAL,
  SALES_MARKET_SCOPE_CAVEAT,
  SALES_MARKET_EXCLUDED_HEADING,
  SALES_MARKET_CAUSE_HEADING,
  SALES_MARKET_VERIFIED,
  SALES_PRODUCT_SECTION_HEADING,
  SALES_PARTIAL_HEADING,
  SALES_PARTIAL_TOTAL_HEADING,
  SALES_PARTIAL_TOTAL_NOTICE,
  SALES_QUANTITY_ONLY_NOTICE,
  SALES_SOLD_OUT_NO_RETURN_LABEL,
  SALES_SOLD_OUT_NO_RETURN_SUFFIX,
  SALES_TOTAL_HEADING,
  SALES_VALUE_UNAVAILABLE,
} from "./message";

const DATE = "2026-07-25";
const SOURCE = "Csource000000aaaaaa";
const MARKET = "ตลาดกี้";

function row(overrides: Partial<SalesSourceRow> = {}): SalesSourceRow {
  return {
    sourceId: SOURCE,
    marketName: MARKET,
    sessionId: "session-main",
    sessionKind: "main",
    productName: "หมอนทอง",
    unit: "โล",
    quantity: 0,
    transactionType: "เบิก",
    ...overrides,
  };
}

const PRICES = new Map([[centralPriceMapKey("หมอนทอง", "โล"), 12_000]]);

function report(rows: readonly SalesSourceRow[], options = {}) {
  return calculateSalesReport({ businessDate: DATE, rows, centralPrices: PRICES, ...options });
}

const TRUSTED_ROWS = [
  row({ quantity: 10, transactionType: "เบิก" }),
  row({ quantity: 2, transactionType: "คืน" }),
  row({ quantity: 1, transactionType: "คืนเสีย" }),
];

describe("P1 manual message", () => {
  test("shows W / R / D / sold / central price / expected sales", () => {
    const text = buildSalesSummaryBlocks(report(TRUSTED_ROWS)).join("\n\n");

    expect(text).toContain(SALES_MANUAL_TITLE);
    expect(text).toContain("หมอนทอง (กิโล)");
    expect(text).toContain("เบิก 10 • คืน 2 • เสีย 1");
    expect(text).toContain("ขาย 7 กิโล");
    expect(text).toContain("ราคากลาง 120.00 → 840.00 บาท");
  });

  test("a fully verified day is labelled as a total", () => {
    const text = buildSalesSummaryBlocks(report(TRUSTED_ROWS)).join("\n\n");
    expect(text).toContain(SALES_TOTAL_HEADING);
    expect(text).not.toContain(SALES_PARTIAL_HEADING);
  });

  test("a partial day is never labelled as total sales", () => {
    const text = buildSalesSummaryBlocks(
      report([...TRUSTED_ROWS, row({ productName: "ชะอม", unit: "กำ", quantity: 5 })]),
    ).join("\n\n");

    expect(text).toContain(SALES_PARTIAL_HEADING);
    // The all-market figure must not carry the "total sales" heading …
    expect(text).not.toContain(`${SALES_TOTAL_HEADING}\n840.00`);
    // … and the blocked entry has to say why. ชะอม is withdrawal-only and
    // unpriced, so it is quantity-trusted but has no central price.
    expect(text).toContain(SALES_BLOCKED_HEADING);
    expect(text).toContain("ไม่มีราคากลาง");
  });

  test("a blocked row shows no sold quantity and no value", () => {
    const text = buildSalesSummaryBlocks(
      report([row({ quantity: 5, transactionType: "คืน" })]),
    ).join("\n\n");

    expect(text).toContain("ขาย —");
    expect(text).toContain("มีคืนแต่ไม่มีเบิก");
    expect(text).not.toContain("ราคากลาง");
  });

  test("a value-blocked row shows the trusted quantity but no value", () => {
    const text = buildSalesSummaryBlocks(
      calculateSalesReport({
        businessDate: DATE,
        rows: [row({ quantity: 10 }), row({ quantity: 4, transactionType: "คืน" })],
      }),
    ).join("\n\n");

    expect(text).toContain("ขาย 6 กิโล");
    expect(text).toContain("ยอดขาย — (ไม่มีราคากลาง)");
  });

  test("a scope-level integrity problem is stated with its count", () => {
    const text = buildSalesSummaryBlocks(
      report(TRUSTED_ROWS, { scopeBlockers: [{ kind: "unresolved_pending_session", count: 2 }] }),
    ).join("\n\n");

    expect(text).toContain("มีชุดข้อมูลที่ยังไม่ปิด/ปิดไม่สำเร็จ 2 ชุด");
    expect(text).toContain(SALES_PARTIAL_HEADING);
  });

  test("an empty day says so instead of reporting zero sales", () => {
    const text = buildSalesSummaryBlocks(report([])).join("\n\n");
    expect(text).toContain(SALES_EMPTY_NOTICE);
    expect(text).not.toContain(SALES_TOTAL_HEADING);
  });

  test("a market with an unresolved name is labelled, not dropped", () => {
    const text = buildSalesSummaryBlocks(
      report([row({ marketName: null, quantity: 5 })]),
    ).join("\n\n");
    expect(text).toContain("ไม่ระบุตลาด");
    expect(text).toContain("ระบุตลาดไม่ได้");
  });

  test("the reply is chunked and capped at the LINE reply limit", () => {
    const many: SalesSourceRow[] = [];
    for (let index = 0; index < 400; index += 1) {
      many.push(row({ productName: `สินค้า${index}`, unit: "กำ", quantity: 5 }));
    }

    const messages = buildSalesSummaryMessages(report(many));
    expect(messages.length).toBeLessThanOrEqual(5);
    for (const message of messages) expect([...message].length).toBeLessThanOrEqual(4000);
    // The answer and the blocked list lead, so a capped reply keeps what matters.
    expect(messages[0]).toContain(SALES_MANUAL_TITLE);
  });
});

describe("P1 automatic message — executive summary", () => {
  test("carries the same numbers under the automatic title", () => {
    const text = buildSalesAutoBlocks(report(TRUSTED_ROWS)).join("\n\n");
    expect(text).toContain(SALES_AUTO_TITLE);
    expect(text).toContain("840.00 บาท");
  });

  test("states trusted and untrusted row counts", () => {
    const text = buildSalesAutoBlocks(
      report([...TRUSTED_ROWS, row({ productName: "ชะอม", unit: "กำ", quantity: 5 })]),
    ).join("\n\n");

    expect(text).toContain("✅ ยืนยันได้ 1 รายการ");
    expect(text).toContain("⚠️ ยืนยันไม่ได้ 1 รายการ");
  });

  test("gives one coherent status block per market", () => {
    const text = buildSalesAutoBlocks(
      report([
        ...TRUSTED_ROWS,
        row({ marketName: "ตลาดน้อย", sessionId: "s-b", productName: "ชะอม", unit: "กำ", quantity: 5 }),
      ]),
    ).join("\n\n");

    expect(text).toContain(SALES_MARKET_SECTION_HEADING);
    // Fully verified: a verdict and a total, nothing else.
    expect(text).toContain(`🏪 ตลาดกี้\n${SALES_MARKET_VERIFIED}\nยอดขายรวม 840.00 บาท`);
    // Unpriced: the market says what it could confirm and names what it excluded.
    expect(text).toContain(`🏪 ตลาดน้อย\n${SALES_MARKET_PARTIAL}`);
    expect(text).toContain("ยอดที่ยืนยันแล้ว 0.00 บาท");
    expect(text).toContain("• ชะอม (กำ) — ไม่มีราคากลาง");
    // The old pair of lines about one market is gone.
    expect(text).not.toContain(`ตลาดน้อย — ${SALES_VALUE_UNAVAILABLE}`);
  });

  test("P4: pending-review money is labelled by review state, never under ยังไม่รวม", () => {
    const built = calculateSalesReport({
      businessDate: DATE,
      rows: [
        row({ quantity: 10, enteredPriceSatang: 12_000 }),
        row({ productName: "มังคุด", quantity: 2, enteredPriceSatang: 5_000 }),
      ],
      centralPrices: PRICES,
    });
    const text = buildSalesAutoMessages(built).join("\n");

    expect(text).toContain("ยอดขายรวม 1,300.00 บาท");
    expect(text).toContain("รอตรวจราคา:\n• มังคุด");
    const excludedSection = text.split(SALES_MARKET_EXCLUDED_HEADING)[1] ?? "";
    expect(excludedSection).not.toContain("มังคุด");
  });

  test("return-pending money is shown under รอข้อมูลคืน, not ยังไม่รวม", () => {
    const roundId = "round-return-pending";
    const built = calculateSalesReport({
      businessDate: DATE,
      rows: [
        row({ accountabilityRoundId: roundId, quantity: 10, enteredPriceSatang: 12_000 }),
        row({ accountabilityRoundId: roundId, productName: "มังคุด", quantity: 5, enteredPriceSatang: 5_000 }),
        row({ accountabilityRoundId: roundId, productName: "มังคุด", quantity: 1, transactionType: "คืน", sessionId: "s-return" }),
      ],
      centralPrices: new Map([
        [centralPriceMapKey("หมอนทอง", "โล"), 12_000],
        [centralPriceMapKey("มังคุด", "โล"), 5_000],
      ]),
      persistedReturnRounds: new Set([roundId]),
    });
    const text = buildSalesAutoMessages(built).join("\n");

    expect(text).toContain("รอข้อมูลคืน:\n• หมอนทอง");
    const excludedSection = text.split(SALES_MARKET_EXCLUDED_HEADING)[1] ?? "";
    expect(excludedSection).not.toContain("หมอนทอง");
  });

  test("a day-level blocker adds only a day-level caveat, not a product omission heading", () => {
    const text = buildSalesAutoBlocks(
      report(TRUSTED_ROWS, { scopeBlockers: [{ kind: "unresolved_pending_session", count: 1 }] }),
    ).join("\n\n");

    expect(text).toContain(SALES_MARKET_SCOPE_CAVEAT);
    expect(text).not.toContain(SALES_MARKET_EXCLUDED_HEADING);
    expect(text).not.toContain(SALES_MARKET_CAUSE_HEADING);
  });

  test("trusted and unresolved counts partition every identity exactly once", () => {
    const built = report([
      ...TRUSTED_ROWS,
      row({ marketName: "ตลาดน้อย", sessionId: "s-b", productName: "ชะอม", unit: "กำ", quantity: 5 }),
      row({ marketName: "ตลาดสาม", sessionId: "s-c", productName: "แตงโม", unit: "ลูก", quantity: null }),
    ]);
    const identityRows = built.markets.flatMap((market) => market.rows);
    const unresolved = identityRows.filter((row) => row.status !== "TRUSTED");
    const groups = groupMarketsByLabel(built);

    expect(
      built.allMarkets.trustedRowCount
      + built.allMarkets.valueBlockedRowCount
      + built.allMarkets.quantityBlockedRowCount,
    ).toBe(identityRows.length);
    expect(unresolved).toHaveLength(
      built.allMarkets.valueBlockedRowCount + built.allMarkets.quantityBlockedRowCount,
    );
    expect(built.blocked.map((row) => row.marketKey + row.productName + row.unit).sort()).toEqual(
      unresolved.map((row) => row.marketKey + row.productName + row.unit).sort(),
    );
    expect(groups.flatMap((group) => group.rows)).toHaveLength(identityRows.length);
    expect(new Set(groups.map((group) => group.marketLabel)).size).toBe(groups.length);
  });

  test("every unresolved line is named inside its own market, never only counted", () => {
    const many: SalesSourceRow[] = [];
    for (let index = 0; index < 40; index += 1) {
      many.push(row({ productName: `สินค้า${index}`, unit: "กำ", quantity: 5 }));
    }

    const built = report(many);
    const text = buildSalesAutoBlocks(built).join("\n\n");

    expect(built.blocked).toHaveLength(40);
    // The header count reconciles with lines a human can actually point at.
    expect(text).toContain("⚠️ ยืนยันไม่ได้ 40 รายการ");
    expect(text).toContain("• สินค้า0 (กำ) — ไม่มีราคากลาง");
    expect(text).toContain("• สินค้า39 (กำ) — ไม่มีราคากลาง");
    // …and the separate reason-count section that double-counted them is gone.
    expect(text).not.toContain("ไม่มีราคากลาง — 40 รายการ");
  });

  test("one market with one unresolved price stays a single block", () => {
    const text = buildSalesAutoBlocks(
      report(
        [
          ...TRUSTED_ROWS,
          row({ productName: "อะโวคาโด", unit: "โล", quantity: 3 }),
        ],
        { priceConflicts: new Set([centralPriceMapKey("อะโวคาโด", "โล")]) },
      ),
    ).join("\n\n");

    expect(text.match(/🏪 ตลาดกี้/g)).toHaveLength(1);
    expect(text).toContain(SALES_MARKET_PARTIAL);
    expect(text).toContain("• อะโวคาโด (กิโล) — ราคากลางขัดแย้ง รอผู้ดูแลยืนยัน");
  });

  test("drops the full product dump", () => {
    const text = buildSalesAutoBlocks(report(TRUSTED_ROWS)).join("\n\n");
    expect(text).not.toContain(SALES_PRODUCT_SECTION_HEADING);
    expect(text).not.toContain("หมอนทอง (กิโล) — ขาย 7");
  });

  test("a real production-shaped day fits in two LINE messages", () => {
    // 2026-07-25 shape: ~17 markets, ~130 products, ~160 blocked identities.
    const many: SalesSourceRow[] = [];
    for (let market = 0; market < 17; market += 1) {
      for (let product = 0; product < 8; product += 1) {
        const base = {
          marketName: `ตลาด${market}`,
          sessionId: `s-${market}`,
          productName: `สินค้า${product}`,
          unit: "กำ",
        };
        many.push(row({ ...base, quantity: 10 }));
        // Half the identities close properly, half stay blocked.
        if (product % 2 === 0) many.push(row({ ...base, quantity: 4, transactionType: "คืน" }));
      }
    }

    const messages = buildSalesAutoMessages(report(many));
    expect(messages.length).toBeLessThanOrEqual(2);
    for (const message of messages) expect([...message].length).toBeLessThanOrEqual(4000);
  });

  test("does not report cash, transfers, slips, cost or profit", () => {
    const text = buildSalesAutoBlocks(report(TRUSTED_ROWS)).join("\n\n");
    for (const forbidden of ["เงินสด", "ยอดโอน", "สลิป", "ต้นทุน", "กำไร", "ขาดเกิน"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("scope blockers are still stated in full — fail-closed is not summarised away", () => {
    const text = buildSalesAutoBlocks(
      report(TRUSTED_ROWS, { scopeBlockers: [{ kind: "unresolved_pending_session", count: 2 }] }),
    ).join("\n\n");

    expect(text).toContain("มีชุดข้อมูลที่ยังไม่ปิด/ปิดไม่สำเร็จ 2 ชุด");
    // The headline total uses the stronger partial-total wording, not the
    // per-market/product SALES_PARTIAL_HEADING.
    expect(text).toContain(SALES_PARTIAL_TOTAL_HEADING);
    expect(text).toContain(SALES_PARTIAL_TOTAL_NOTICE);
  });
});

describe("P1 partial-total warning", () => {
  test("a partial auto report states the warning and the caveat next to the total", () => {
    const text = buildSalesAutoBlocks(
      report([...TRUSTED_ROWS, row({ productName: "ชะอม", unit: "กำ", quantity: 5 })]),
    ).join("\n\n");

    expect(text).toContain(SALES_PARTIAL_TOTAL_HEADING);
    expect(text).toContain(SALES_PARTIAL_TOTAL_NOTICE);
  });

  test("a fully authoritative auto report never claims to be partial", () => {
    const text = buildSalesAutoBlocks(report(TRUSTED_ROWS)).join("\n\n");

    expect(text).toContain(SALES_TOTAL_HEADING);
    expect(text).not.toContain(SALES_PARTIAL_TOTAL_HEADING);
    expect(text).not.toContain(SALES_PARTIAL_TOTAL_NOTICE);
  });

  test("a partial manual report states the same warning on its headline total", () => {
    const text = buildSalesSummaryBlocks(
      report([...TRUSTED_ROWS, row({ productName: "ชะอม", unit: "กำ", quantity: 5 })]),
    ).join("\n\n");

    expect(text).toContain(SALES_PARTIAL_TOTAL_HEADING);
    expect(text).toContain(SALES_PARTIAL_TOTAL_NOTICE);
  });

  test("a fully authoritative manual report never claims to be partial", () => {
    const text = buildSalesSummaryBlocks(report(TRUSTED_ROWS)).join("\n\n");

    expect(text).toContain(SALES_TOTAL_HEADING);
    expect(text).not.toContain(SALES_PARTIAL_TOTAL_HEADING);
    expect(text).not.toContain(SALES_PARTIAL_TOTAL_NOTICE);
  });

  test("the P1 calculation and blocker classification are untouched by the wording change", () => {
    const built = report([...TRUSTED_ROWS, row({ productName: "ชะอม", unit: "กำ", quantity: 5 })]);

    expect(built.allMarkets.expectedSalesSatang).toBe(84_000);
    expect(built.allMarkets.trustedRowCount).toBe(1);
    expect(built.allMarkets.valueBlockedRowCount + built.allMarkets.quantityBlockedRowCount).toBe(1);
    expect(built.blocked).toHaveLength(1);
  });

  test("introduces no stock, purchase, cost, cash, slip, or profit wording", () => {
    const text = buildSalesAutoBlocks(
      report([...TRUSTED_ROWS, row({ productName: "ชะอม", unit: "กำ", quantity: 5 })]),
    ).join("\n\n");

    for (const forbidden of ["สต๊อก", "ซื้อ", "ต้นทุน", "เงินสด", "สลิป", "กำไร"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("P1 message wording", () => {
  test("a quantity-complete, value-partial day says exactly that", () => {
    // Sold quantity is proven for both products; only ชะอม lacks a price.
    const text = buildSalesSummaryBlocks(
      report([
        ...TRUSTED_ROWS,
        row({ productName: "ชะอม", unit: "กำ", quantity: 8 }),
        row({ productName: "ชะอม", unit: "กำ", quantity: 3, transactionType: "คืน" }),
      ]),
    ).join("\n\n");

    expect(text).toContain(SALES_PARTIAL_HEADING);
    expect(text).toContain(SALES_QUANTITY_ONLY_NOTICE);
    // The quantity is reported in full, the money is marked partial.
    expect(text).toContain("ชะอม (กำ) — ขาย 5 • ยอดเงินยังคำนวณไม่ได้");
  });

  test("a quantity-blocked day does not claim the quantity is complete", () => {
    const text = buildSalesSummaryBlocks(
      report([
        ...TRUSTED_ROWS,
        // A return with no withdrawal of its own: genuinely quantity-blocked.
        row({ productName: "ชะอม", unit: "กำ", quantity: 5, transactionType: "คืน" }),
      ]),
    ).join("\n\n");

    expect(text).not.toContain(SALES_QUANTITY_ONLY_NOTICE);
  });

  test("the overflow notice never points at a Sales web page that does not exist", () => {
    const many: SalesSourceRow[] = [];
    for (let index = 0; index < 400; index += 1) {
      many.push(row({ productName: `สินค้า${index}`, unit: "กำ", quantity: 5 }));
    }

    const messages = buildSalesSummaryMessages(report(many));
    const last = messages[messages.length - 1];

    expect(messages).toHaveLength(5);
    expect(last).toContain(SALES_OVERFLOW_NOTICE.trim());
    expect(last).not.toContain("หน้าเว็บ");
  });
});

describe("P1 empty day must not hide blockers", () => {
  const blockers = [{ kind: "unresolved_pending_session" as const, count: 1 }];

  test("manual: no rows and no blockers is a real 'no sales' answer", () => {
    const text = buildSalesSummaryBlocks(report([])).join("\n\n");
    expect(text).toContain(SALES_EMPTY_NOTICE);
    expect(text).not.toContain(SALES_NO_ROWS_BLOCKED_NOTICE);
  });

  test("manual: no rows WITH blockers is reported as incomplete, not as no sales", () => {
    const text = buildSalesSummaryBlocks(report([], { scopeBlockers: blockers })).join("\n\n");

    expect(text).not.toContain(SALES_EMPTY_NOTICE);
    expect(text).toContain(SALES_NO_ROWS_BLOCKED_NOTICE);
    expect(text).toContain("มีชุดข้อมูลที่ยังไม่ปิด/ปิดไม่สำเร็จ 1 ชุด");
  });

  test("auto: no rows WITH blockers is reported as incomplete, not as no sales", () => {
    const text = buildSalesAutoBlocks(report([], { scopeBlockers: blockers })).join("\n\n");

    expect(text).not.toContain(SALES_EMPTY_NOTICE);
    expect(text).toContain(SALES_NO_ROWS_BLOCKED_NOTICE);
    expect(text).toContain("มีชุดข้อมูลที่ยังไม่ปิด/ปิดไม่สำเร็จ 1 ชุด");
  });

  test("auto: no rows and no blockers asks for the latest-data hint", () => {
    expect(salesAutoNeedsLatestDataHint(report([]))).toBe(true);
    expect(salesAutoNeedsLatestDataHint(report([], { scopeBlockers: blockers }))).toBe(false);
    expect(salesAutoNeedsLatestDataHint(report(TRUSTED_ROWS))).toBe(false);
  });

  test("every scope blocker is listed, never summarised away", () => {
    const text = buildSalesAutoBlocks(
      report([], {
        scopeBlockers: [
          { kind: "unresolved_pending_session" as const, count: 2 },
          { kind: "message_parser_error" as const, count: 3 },
          { kind: "unattributable_session" as const, count: 1 },
        ],
      }),
    ).join("\n\n");

    expect(text).toContain("ยังไม่ปิด/ปิดไม่สำเร็จ 2 ชุด");
    expect(text).toContain("อ่านไม่สำเร็จ 3 ข้อความ");
    expect(text).toContain("ระบุตลาดไม่ได้ 1 ชุด");
  });
});

describe("P1 auto empty state", () => {
  const FOUND: LatestDataLookup = {
    status: "found",
    hint: { date: "2026-07-24", marketCount: 10 },
  };

  test("names the requested date instead of a vague 'today'", () => {
    const text = buildSalesAutoBlocks(report([]), { status: "none" }).join("\n\n");

    expect(text).toContain(SALES_AUTO_TITLE);
    expect(text).toContain(`${SALES_NO_DATA_PREFIX} 25 กรกฎาคม 2569`);
    expect(text).not.toContain(SALES_EMPTY_NOTICE);
  });

  test("found: shows the latest date as context, never as the day's total", () => {
    const text = buildSalesAutoBlocks(report([]), FOUND).join("\n\n");

    expect(text).toContain(`${SALES_NO_DATA_PREFIX} 25 กรกฎาคม 2569`);
    expect(text).toContain("ข้อมูลล่าสุดที่มีคือวันที่ 24 กรกฎาคม 2569");
    expect(text).toContain("พบข้อมูล 10 ตลาด");
    // The report's date stays the requested one and carries no revenue figure
    // borrowed from the prior day.
    expect(text).toContain("ข้อมูลวันที่ 25 กรกฎาคม 2569");
    expect(text).not.toContain("ข้อมูลวันที่ 24 กรกฎาคม 2569");
    expect(text).not.toContain(SALES_TOTAL_HEADING);
    expect(text).not.toContain("บาท");
    expect(text).not.toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
  });

  test("none: says plainly that no sales exist anywhere", () => {
    const text = buildSalesAutoBlocks(report([]), { status: "none" }).join("\n\n");

    expect(text).toContain(SALES_NO_HISTORY_NOTICE);
    expect(text).not.toContain("ข้อมูลล่าสุดที่มีคือ");
    expect(text).not.toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
  });

  test("unavailable: says the check failed and never claims history is empty", () => {
    const text = buildSalesAutoBlocks(report([]), { status: "unavailable" }).join("\n\n");

    expect(text).toContain(`${SALES_NO_DATA_PREFIX} 25 กรกฎาคม 2569`);
    expect(text).toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
    expect(text).not.toContain(SALES_NO_HISTORY_NOTICE);
    expect(text).not.toContain("ข้อมูลล่าสุดที่มีคือ");
  });

  test("an unpassed lookup defaults to 'could not check', never to 'nothing exists'", () => {
    const text = buildSalesAutoBlocks(report([])).join("\n\n");

    expect(text).toContain(LATEST_DATA_UNAVAILABLE_NOTICE);
    expect(text).not.toContain(SALES_NO_HISTORY_NOTICE);
  });

  test("omits the market count when the latest date resolved no market", () => {
    const text = buildSalesAutoBlocks(report([]), {
      status: "found",
      hint: { date: "2026-07-24", marketCount: 0 },
    }).join("\n\n");

    expect(text).toContain("ข้อมูลล่าสุดที่มีคือวันที่ 24 กรกฎาคม 2569");
    expect(text).not.toContain("พบข้อมูล 0 ตลาด");
  });

  test("a day with sales renders identically in all three lookup states", () => {
    const baseline = buildSalesAutoBlocks(report(TRUSTED_ROWS), { status: "none" });

    expect(buildSalesAutoBlocks(report(TRUSTED_ROWS), FOUND)).toEqual(baseline);
    expect(buildSalesAutoBlocks(report(TRUSTED_ROWS), { status: "unavailable" })).toEqual(baseline);
  });

  test("the empty state fits in a single LINE message in every state", () => {
    for (const latest of [FOUND, { status: "none" } as const, { status: "unavailable" } as const]) {
      const messages = buildSalesAutoMessages(report([]), { latest });
      expect(messages).toHaveLength(1);
      expect(messages[0].length).toBeLessThanOrEqual(LINE_MESSAGE_MAX_CODE_POINTS);
    }
  });
});

describe("P1 manual message keeps the full audit detail", () => {
  test("the manual reply still lists products and every blocked row", () => {
    const built = report([
      ...TRUSTED_ROWS,
      row({ productName: "ชะอม", unit: "กำ", quantity: 5 }),
    ]);
    const text = buildSalesSummaryBlocks(built).join("\n\n");

    expect(text).toContain(SALES_PRODUCT_SECTION_HEADING);
    expect(text).toContain("เบิก 10 • คืน 2 • เสีย 1");
    for (const blocked of built.blocked) expect(text).toContain(blocked.productName);
  });
});

describe("P1 unpriced value wording", () => {
  test("an unpriced day never prints a figure that reads as zero revenue", () => {
    const text = buildSalesSummaryBlocks(
      calculateSalesReport({
        businessDate: DATE,
        rows: [row({ quantity: 10 }), row({ quantity: 4, transactionType: "คืน" })],
      }),
    ).join("\n\n");

    expect(text).toContain(SALES_VALUE_UNAVAILABLE);
    expect(text).not.toContain("0.00 บาท");
  });

  test("a genuine trusted zero still prints 0.00, because that IS the revenue", () => {
    const text = buildSalesSummaryBlocks(
      report([row({ quantity: 10 }), row({ quantity: 10, transactionType: "คืน" })]),
    ).join("\n\n");

    expect(text).toContain("0.00 บาท");
    expect(text).not.toContain(SALES_VALUE_UNAVAILABLE);
  });

  test("a partial subtotal still shows the verified figure alongside the caveat", () => {
    const text = buildSalesSummaryBlocks(
      report([...TRUSTED_ROWS, row({ productName: "ชะอม", unit: "กำ", quantity: 5 })]),
    ).join("\n\n");

    expect(text).toContain(SALES_PARTIAL_HEADING);
    expect(text).toContain("840.00 บาท");
  });
});

// ── Sold out by absence of return — presentation ────────────────────────────

describe("P1 sold-out by absence of return — presentation", () => {
  test("A: an automatic report with withdrawal-only rows states the sold-out count", () => {
    const rows = [
      row({ productName: "หมอนทอง", unit: "โล", quantity: 10, transactionType: "เบิก" }),
    ];
    const text = buildSalesAutoBlocks(report(rows)).join("\n\n");

    expect(text).toContain("1,200.00 บาท");
    expect(text).toContain(SALES_SOLD_OUT_NO_RETURN_LABEL);
    expect(text).toContain(`✅ ${SALES_SOLD_OUT_NO_RETURN_LABEL} — 1 รายการ`);
    expect(text).not.toContain("missing_return_evidence");
    expect(text).not.toContain("ยังไม่มีข้อมูลชั่งคืน");
  });

  test("B: an automatic report with no qualifying rows omits the sold-out line", () => {
    const text = buildSalesAutoBlocks(report(TRUSTED_ROWS)).join("\n\n");
    expect(text).not.toContain(SALES_SOLD_OUT_NO_RETURN_LABEL);
  });

  test("C: the same product sold out in two markets counts as two identities", () => {
    const rows = [
      row({ productName: "หมอนทอง", unit: "โล", quantity: 10, transactionType: "เบิก" }),
      row({
        marketName: "ตลาดน้อย",
        sessionId: "s-b",
        productName: "หมอนทอง",
        unit: "โล",
        quantity: 5,
        transactionType: "เบิก",
      }),
    ];
    const text = buildSalesAutoBlocks(report(rows)).join("\n\n");
    expect(text).toContain(`✅ ${SALES_SOLD_OUT_NO_RETURN_LABEL} — 2 รายการ`);
  });

  test("D: multiple withdrawal rows for one identity count once", () => {
    const rows = [
      row({ productName: "หมอนทอง", unit: "โล", quantity: 6, transactionType: "เบิก" }),
      row({
        productName: "หมอนทอง",
        unit: "โล",
        quantity: 4,
        transactionType: "เบิกเพิ่ม",
        sessionId: "session-additional",
        sessionKind: "additional",
      }),
    ];
    const text = buildSalesAutoBlocks(report(rows)).join("\n\n");
    expect(text).toContain(`✅ ${SALES_SOLD_OUT_NO_RETURN_LABEL} — 1 รายการ`);
  });

  test("E: a withdrawal-only row with a missing central price still counts as sold out", () => {
    const rows = [row({ productName: "ชะอม", unit: "กำ", quantity: 8, transactionType: "เบิก" })];
    const built = report(rows);
    const text = buildSalesAutoBlocks(built).join("\n\n");

    expect(built.markets[0].rows[0].status).toBe("VALUE_BLOCKED");
    expect(built.markets[0].rows[0].soldQuantity).toBe(8);
    expect(text).toContain(`✅ ${SALES_SOLD_OUT_NO_RETURN_LABEL} — 1 รายการ`);
    expect(text).toContain(SALES_VALUE_UNAVAILABLE);
  });

  test("F: a withdrawal-only row with a central-price conflict still counts as sold out", () => {
    const rows = [row({ quantity: 8, transactionType: "เบิก" })];
    const built = report(rows, {
      priceConflicts: new Set([centralPriceMapKey("หมอนทอง", "โล")]),
    });
    const text = buildSalesAutoBlocks(built).join("\n\n");

    expect(built.markets[0].rows[0].status).toBe("VALUE_BLOCKED");
    expect(built.markets[0].rows[0].expectedSalesSatang).toBeNull();
    expect(text).toContain(`✅ ${SALES_SOLD_OUT_NO_RETURN_LABEL} — 1 รายการ`);
  });

  test("G: quantity-blocked rows never count as sold out", () => {
    const rows = [
      // Return without withdrawal.
      row({ productName: "ชะอม", unit: "กำ", quantity: 4, transactionType: "คืน" }),
      // Returns exceeding withdrawal.
      row({ productName: "คะน้า", unit: "กำ", quantity: 5, transactionType: "เบิก" }),
      row({ productName: "คะน้า", unit: "กำ", quantity: 8, transactionType: "คืน" }),
      // Session parser errors.
      row({
        productName: "ผักบุ้ง",
        unit: "กำ",
        quantity: 10,
        transactionType: "เบิก",
        sessionIssues: ["session_parser_errors"],
      }),
    ];
    const built = report(rows);
    const text = buildSalesAutoBlocks(built).join("\n\n");

    expect(built.markets[0].rows.every((r) => r.status === "QUANTITY_BLOCKED")).toBe(true);
    expect(text).not.toContain(SALES_SOLD_OUT_NO_RETURN_LABEL);
  });

  test("H: manual detail states no-return wording for a qualifying row", () => {
    const rows = [row({ quantity: 50, transactionType: "เบิก" })];
    const text = buildSalesSummaryBlocks(report(rows)).join("\n\n");

    expect(text).toContain(`เบิก 50 • ${SALES_NO_RETURN_ROW_LABEL}`);
    expect(text).toContain(`ขาย 50 กิโล (${SALES_SOLD_OUT_NO_RETURN_SUFFIX})`);
    expect(text).not.toContain("คืน 0");
  });

  test("I: a row with real return data keeps the normal เบิก/คืน/เสีย presentation", () => {
    const text = buildSalesSummaryBlocks(report(TRUSTED_ROWS)).join("\n\n");

    expect(text).toContain("เบิก 10 • คืน 2 • เสีย 1");
    expect(text).toContain("ขาย 7 กิโล");
    expect(text).not.toContain(SALES_NO_RETURN_ROW_LABEL);
    expect(text).not.toContain(SALES_SOLD_OUT_NO_RETURN_SUFFIX);
  });

  test("an omitted product in a round with a return is not sold-out wording", () => {
    const ROUND = "round-with-return";
    const rows = [
      row({
        accountabilityRoundId: ROUND,
        productName: "หมอนทอง",
        quantity: 10,
        transactionType: "เบิก",
      }),
      row({
        accountabilityRoundId: ROUND,
        productName: "มะม่วง",
        quantity: 5,
        transactionType: "เบิก",
      }),
      row({
        accountabilityRoundId: ROUND,
        productName: "หมอนทอง",
        quantity: 2,
        transactionType: "คืน",
        sessionId: "session-return",
      }),
    ];
    const built = report(rows, {
      centralPrices: new Map([
        [centralPriceMapKey("หมอนทอง", "โล"), 12_000],
        [centralPriceMapKey("มะม่วง", "โล"), 8_000],
      ]),
      persistedReturnRounds: new Set([ROUND]),
    });
    const auto = buildSalesAutoBlocks(built).join("\n\n");
    const manual = buildSalesSummaryBlocks(built).join("\n\n");

    expect(auto).not.toContain(SALES_SOLD_OUT_NO_RETURN_LABEL);
    expect(auto).toContain("รอบนี้มีรายการชั่งคืน แต่ไม่พบสินค้านี้ในรายการชั่งคืน");
    expect(auto).toContain("มะม่วง (กิโล) — รอบนี้มีรายการชั่งคืน แต่ไม่พบสินค้านี้ในรายการชั่งคืน");
    expect(manual).toContain("ขาย — (รอบนี้มีรายการชั่งคืน แต่ไม่พบสินค้านี้ในรายการชั่งคืน)");
    expect(auto).not.toContain("7e3717eb");
    expect(auto).not.toContain(ROUND);
    expect(manual).not.toContain(ROUND);
  });
});
