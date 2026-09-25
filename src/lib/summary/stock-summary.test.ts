import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  preloadRuntimeProductCodes,
  resetRuntimeProductCodesForTests,
  resolveProductCode,
  runtimeProductCodeEntryForName,
} from "@/lib/produce/product-code/resolver";
import {
  buildStockSummaryFromRows,
  type StockSummary,
} from "./stock-summary";
import type { RemainingFruitSourceRow } from "./remaining-fruit";
import { buildRemainingFruitMessagesFromRows } from "./remaining-fruit-message";
import { buildStockSummaryBlocks } from "./stock-summary-message";

const TX_WITHDRAW = "เบิก";
const TX_WITHDRAW_MORE = "เบิกเพิ่ม";
const TX_RETURN = "คืน";
const TX_DAMAGED = "คืนเสีย";
const TX_DAMAGED_LEGACY = "เสีย";

const DATE = "2026-07-25";

const MARKET_A = "ตลาดกี้";
const MARKET_B = "ตลาดน้อย";

function row(overrides: Partial<RemainingFruitSourceRow> = {}): RemainingFruitSourceRow {
  return {
    market_name: MARKET_A,
    product_name: "แตงโม",
    quantity: 10,
    unit: "ลูก",
    transaction_type: TX_RETURN,
    ...overrides,
  };
}

function productIn(summary: StockSummary, category: string, name: string) {
  const group = summary.categories.find((g) => g.category === category);
  return group?.products.find((p) => p.productName === name);
}

function allProducts(summary: StockSummary) {
  return summary.categories.flatMap((g) => g.products);
}

describe("stock semantics", () => {
  test("aggregates good returns for one product across all markets", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ market_name: MARKET_A, quantity: 20 }),
      row({ market_name: MARKET_B, quantity: 15 }),
    ]);

    const watermelon = productIn(summary, "ผลไม้", "แตงโม");
    expect(watermelon?.quantity).toBe(35);
    expect(watermelon?.markets.map((m) => m.marketName)).toEqual([MARKET_A, MARKET_B]);
    expect(summary.isComplete).toBe(true);
  });

  test("คืนเสีย is never counted as sellable stock", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ quantity: 30, transaction_type: TX_RETURN }),
      row({ quantity: 12, transaction_type: TX_DAMAGED }),
      row({ quantity: 4, transaction_type: TX_DAMAGED_LEGACY }),
    ]);

    // 30 good return only — damage neither adds to nor subtracts from stock.
    expect(productIn(summary, "ผลไม้", "แตงโม")?.quantity).toBe(30);
  });

  test("withdrawal without a good return is incomplete, not remaining = 0", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ quantity: 100, transaction_type: TX_WITHDRAW }),
    ]);

    expect(allProducts(summary)).toHaveLength(0);
    expect(summary.isComplete).toBe(false);
    expect(summary.incomplete).toEqual([
      { marketName: MARKET_A, productName: "แตงโม", unit: "ลูก", withdrawnQuantity: 100 },
    ]);
  });

  test("คืนเสีย alone does not satisfy the ชั่งคืน requirement", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ quantity: 100, transaction_type: TX_WITHDRAW }),
      row({ quantity: 100, transaction_type: TX_DAMAGED }),
    ]);

    expect(summary.isComplete).toBe(false);
    expect(summary.incomplete).toHaveLength(1);
    expect(allProducts(summary)).toHaveLength(0);
  });

  test("completeness is tracked per market + product + unit", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      // MARKET_A closed its แตงโม
      row({ market_name: MARKET_A, quantity: 50, transaction_type: TX_WITHDRAW }),
      row({ market_name: MARKET_A, quantity: 20, transaction_type: TX_RETURN }),
      // MARKET_B withdrew the same product and never weighed it back
      row({ market_name: MARKET_B, quantity: 40, transaction_type: TX_WITHDRAW }),
      // MARKET_A withdrew a second product, also unweighed
      row({ market_name: MARKET_A, product_name: "กระท้อน", quantity: 10, unit: "โล", transaction_type: TX_WITHDRAW }),
    ]);

    expect(summary.isComplete).toBe(false);
    expect(summary.incomplete).toEqual([
      { marketName: MARKET_A, productName: "กระท้อน", unit: "โล", withdrawnQuantity: 10 },
      { marketName: MARKET_B, productName: "แตงโม", unit: "ลูก", withdrawnQuantity: 40 },
    ]);
    // The market that did finish still contributes its stock.
    expect(productIn(summary, "ผลไม้", "แตงโม")?.quantity).toBe(20);
  });

  test("เบิกเพิ่ม counts as a withdrawal for completeness", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ quantity: 25, transaction_type: TX_WITHDRAW_MORE }),
    ]);

    expect(summary.isComplete).toBe(false);
    expect(summary.incomplete[0]?.withdrawnQuantity).toBe(25);
  });

  test("additional sessions accumulate into the same product total", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ session_id: "s1", quantity: 12 }),
      row({ session_id: "s2", quantity: 8 }),
    ]);

    expect(productIn(summary, "ผลไม้", "แตงโม")?.quantity).toBe(20);
  });

  test("the report carries no opening balance, intake or carry-forward fields", () => {
    const summary = buildStockSummaryFromRows(DATE, [row({ quantity: 5 })]);
    const product = productIn(summary, "ผลไม้", "แตงโม")!;

    expect(Object.keys(product).sort()).toEqual(["markets", "productName", "quantity", "unit"]);
  });
});

describe("voided sessions", () => {
  // produce_transactions is defined as produce_transactions_all WHERE
  // voided_at IS NULL (migration 0037), so voided rows never reach the report.
  // This asserts the calculation consumes exactly what the view hands it.
  test("rows withheld by the void-filtered view do not contribute", () => {
    const trusted = [row({ quantity: 20 })];
    const withVoided = [...trusted, row({ quantity: 999 })];

    const trustedSummary = buildStockSummaryFromRows(DATE, trusted);
    const voidedSummary = buildStockSummaryFromRows(DATE, withVoided);

    expect(productIn(trustedSummary, "ผลไม้", "แตงโม")?.quantity).toBe(20);
    // Proves the extra row would have counted had the view not filtered it —
    // i.e. exclusion genuinely depends on the view contract, not on luck.
    expect(productIn(voidedSummary, "ผลไม้", "แตงโม")?.quantity).toBe(1019);
  });
});

describe("product identity", () => {
  test("explicit durian aliases aggregate", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ product_name: "หมอนทอง", quantity: 200, unit: "โล" }),
      row({ product_name: "หมอน", quantity: 81.1, unit: "โล" }),
    ]);

    const durian = productIn(summary, "ทุเรียน", "หมอนทอง");
    expect(durian?.quantity).toBeCloseTo(281.1, 5);
    expect(summary.categories.find((g) => g.category === "ทุเรียน")?.products).toHaveLength(1);
  });

  test("สับปะรด misspellings aggregate onto one canonical name", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ product_name: "สับปะรด", quantity: 1, unit: "ลูก" }),
      row({ product_name: "สัปรด", quantity: 2, unit: "ลูก" }),
      row({ product_name: "สัปปรถ", quantity: 3, unit: "ลูก" }),
      row({ product_name: "สัปแรถ", quantity: 4, unit: "ลูก" }),
      row({ product_name: "สีปปะรด", quantity: 5, unit: "ลูก" }),
    ]);

    expect(productIn(summary, "ผลไม้", "สับปะรด")?.quantity).toBe(15);
  });

  test("โชคอนันต์, อะโวคาโด and อินทผาลัม variants aggregate", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ product_name: "โชคอนันต์", quantity: 1, unit: "โล" }),
      row({ product_name: "โชคอนัน", quantity: 2, unit: "โล" }),
      row({ product_name: "โชคิอนันต์", quantity: 3, unit: "โล" }),
      row({ product_name: "อะโวคาโด", quantity: 4, unit: "ลูก" }),
      row({ product_name: "อโวคาโด้", quantity: 5, unit: "ลูก" }),
      row({ product_name: "อะโวอาโด้", quantity: 6, unit: "ลูก" }),
      row({ product_name: "อินทผาลัม", quantity: 7, unit: "โล" }),
      row({ product_name: "อินทผารัม", quantity: 8, unit: "โล" }),
      row({ product_name: "อินทผลัม", quantity: 9, unit: "โล" }),
    ]);

    expect(productIn(summary, "ผลไม้", "โชคอนันต์")?.quantity).toBe(6);
    expect(productIn(summary, "ผลไม้", "อะโวคาโด")?.quantity).toBe(15);
    expect(productIn(summary, "ผลไม้", "อินทผาลัม")?.quantity).toBe(24);
  });

  test("pre-existing deployed aliases still aggregate", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ product_name: "ถั่วพู", quantity: 1, unit: "กำ" }),
      row({ product_name: "ถั่วพํ", quantity: 2, unit: "กำ" }),
      row({ product_name: "เพิ่มถั่วพู", quantity: 3, unit: "กำ" }),
      row({ product_name: "กะหล่ำปี", quantity: 4, unit: "โล" }),
      row({ product_name: "เพิ่มกะหล่ำปี", quantity: 5, unit: "โล" }),
      row({ product_name: "ใบมังลัก", quantity: 6, unit: "กำ" }),
      row({ product_name: "ใบมังลีก", quantity: 7, unit: "กำ" }),
    ]);

    expect(productIn(summary, "ผัก", "ถั่วพู")?.quantity).toBe(6);
    expect(productIn(summary, "ผัก", "กะหล่ำปี")?.quantity).toBe(9);
    expect(productIn(summary, "ผัก", "ใบมังลัก")?.quantity).toBe(13);
  });

  test("เพิ่ม-prefixed names compose with the alias map", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ product_name: "หมอนทอง", quantity: 100, unit: "โล" }),
      // Regression: an alias on the bare name (หมอน → หมอนทอง) used to orphan
      // its เพิ่ม form, because knownNames is built from already-aliased names.
      row({ product_name: "เพิ่มหมอน", quantity: 13.4, unit: "โล" }),
    ]);

    expect(productIn(summary, "ทุเรียน", "หมอนทอง")?.quantity).toBeCloseTo(113.4, 5);
    expect(allProducts(summary).map((p) => p.productName)).not.toContain("เพิ่มหมอน");
  });

  test("existing เพิ่ม-prefix behavior is preserved", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      // via knownNames (bare name present in the same dataset, no alias)
      row({ product_name: "แตงโม", quantity: 10, unit: "ลูก" }),
      row({ product_name: "เพิ่มแตงโม", quantity: 5, unit: "ลูก" }),
      // via an explicit alias declared on the prefixed form itself
      row({ product_name: "เพิ่มถั่วพู", quantity: 3, unit: "กำ" }),
      // via an alias on the bare name reached after stripping
      row({ product_name: "เพิ่มกะหล่ำปี", quantity: 4, unit: "โล" }),
    ]);

    expect(productIn(summary, "ผลไม้", "แตงโม")?.quantity).toBe(15);
    expect(productIn(summary, "ผัก", "ถั่วพู")?.quantity).toBe(3);
    expect(productIn(summary, "ผัก", "กะหล่ำปี")?.quantity).toBe(4);
  });

  test("an unknown เพิ่ม-prefixed product is left untouched", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      // Neither aliased nor present as a bare name — must not be guessed apart.
      row({ product_name: "เพิ่มของไม่รู้จัก", quantity: 2, unit: "ถุง" }),
    ]);

    expect(productIn(summary, "ไม่จัดหมวด", "เพิ่มของไม่รู้จัก")?.quantity).toBe(2);
  });

  test("similar but unlisted names stay separate — no fuzzy merging", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      // Neither is an alias of the other; only a human may declare them equal.
      row({ product_name: "มะม่วง", quantity: 10, unit: "โล" }),
      row({ product_name: "มะม่วงเขียว", quantity: 10, unit: "โล" }),
      row({ product_name: "แตงโม", quantity: 10, unit: "ลูก" }),
      row({ product_name: "แตงโมจินตหรา", quantity: 10, unit: "ลูก" }),
    ]);

    const names = allProducts(summary).map((p) => p.productName).sort();
    expect(names).toContain("มะม่วง");
    expect(names).toContain("มะม่วงเขียว");
    expect(names).toContain("แตงโม");
    expect(names).toContain("แตงโมจินตหรา");
  });

  test("same product with incompatible units never combines", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ product_name: "แตงโม", quantity: 30, unit: "ลูก" }),
      row({ product_name: "แตงโม", quantity: 12, unit: "โล" }),
    ]);

    const watermelons = summary.categories
      .flatMap((g) => g.products)
      .filter((p) => p.productName === "แตงโม");

    expect(watermelons).toHaveLength(2);
    expect(watermelons.map((p) => `${p.unit}:${p.quantity}`).sort()).toEqual([
      "ลูก:30",
      "โล:12",
    ]);
  });

  test("unit spelling variants of the same canonical unit do combine", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ product_name: "กระท้อน", quantity: 40, unit: "โล" }),
      row({ product_name: "กระท้อน", quantity: 42.2, unit: "กก." }),
    ]);

    expect(productIn(summary, "ผลไม้", "กระท้อน")?.quantity).toBeCloseTo(82.2, 5);
  });
});

describe("category grouping", () => {
  test("separates ทุเรียน, ผลไม้ and ผัก and keeps unknowns visible", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ product_name: "หมอนทอง", quantity: 100, unit: "โล" }),
      row({ product_name: "มหาชนก", quantity: 50, unit: "โล" }),
      row({ product_name: "กระชาย", quantity: 4, unit: "แพค" }),
      row({ product_name: "ของแปลกใหม่ไม่เคยเจอ", quantity: 3, unit: "ถุง" }),
    ]);

    expect(summary.categories.map((g) => g.category)).toEqual([
      "ทุเรียน",
      "ผลไม้",
      "ผัก",
      "ไม่จัดหมวด",
    ]);
    expect(productIn(summary, "ไม่จัดหมวด", "ของแปลกใหม่ไม่เคยเจอ")?.quantity).toBe(3);
  });

  test("empty categories are omitted", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ product_name: "กระชาย", quantity: 4, unit: "แพค" }),
    ]);

    expect(summary.categories.map((g) => g.category)).toEqual(["ผัก"]);
  });

  test("products are ordered by remaining quantity, biggest first", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ product_name: "ก้านยาว", quantity: 12.7, unit: "โล" }),
      row({ product_name: "หมอนทอง", quantity: 281.1, unit: "โล" }),
      row({ product_name: "ทุเรียนกล่อง", quantity: 6, unit: "กล่อง" }),
    ]);

    expect(
      summary.categories.find((g) => g.category === "ทุเรียน")?.products.map((p) => p.productName),
    ).toEqual(["หมอนทอง", "ก้านยาว", "ทุเรียนกล่อง"]);
  });
});

describe("runtime dictionary categories", () => {
  beforeEach(() => resetRuntimeProductCodesForTests());
  afterEach(() => resetRuntimeProductCodesForTests());

  function preload(entries: Array<[code: string, categoryCode: string, name: string, enabled?: boolean]>) {
    return preloadRuntimeProductCodes({
      from: () => ({
        select: () => ({
          order: () => ({
            limit: async () => ({
              data: entries.map(([code, categoryCode, name, enabled = true]) => ({
                product_code: code,
                category_code: categoryCode,
                category_name: categoryCode,
                canonical_name: name,
                code_enabled: enabled,
              })),
              error: null,
            }),
          }),
        }),
      }),
    });
  }

  test("a request keeps the snapshot it loaded when a later refresh fails closed", async () => {
    // Request A loads ทุเรียนเทศขนาดใหญ่ as ม; request B's refresh then fails
    // while A is still awaiting its rows.
    const requestA = await preload([["ม901", "ม", "ทุเรียนเทศขนาดใหญ่"]]);
    const requestB = await preloadRuntimeProductCodes({ from: () => { throw new Error("read failed"); } });
    const rows = [row({ product_name: "ทุเรียนเทศขนาดใหญ่", quantity: 5, unit: "กก." })];

    const summaryA = buildStockSummaryFromRows(DATE, rows, { runtimeDictionary: requestA });
    expect(productIn(summaryA, "ผลไม้", "ทุเรียนเทศขนาดใหญ่")?.quantity).toBe(5);
    expect(productIn(summaryA, "ทุเรียน", "ทุเรียนเทศขนาดใหญ่")).toBeUndefined();

    // B and the process-wide resolver stay fail-closed: A's entry is not served.
    expect(runtimeProductCodeEntryForName("ทุเรียนเทศขนาดใหญ่", requestB)).toBeNull();
    expect(runtimeProductCodeEntryForName("ทุเรียนเทศขนาดใหญ่")).toBeNull();
    expect(resolveProductCode("ม901")).toBeNull();
    const summaryB = buildStockSummaryFromRows(DATE, rows, { runtimeDictionary: requestB });
    expect(productIn(summaryB, "ทุเรียน", "ทุเรียนเทศขนาดใหญ่")?.quantity).toBe(5);
    // A caller passing no snapshot (the manual command) reads the process-wide one.
    const manual = buildStockSummaryFromRows(DATE, rows);
    expect(productIn(manual, "ทุเรียน", "ทุเรียนเทศขนาดใหญ่")?.quantity).toBe(5);
  });

  test("an enabled DB-only ม / ผ / ท entry wins over the durian substring guess", async () => {
    await preload([
      ["ม901", "ม", "ทุเรียนเทศขนาดใหญ่"],
      ["ผ901", "ผ", "ผักเชียงดา"],
      ["ท901", "ท", "ชะนีไข่"],
    ]);

    const summary = buildStockSummaryFromRows(DATE, [
      row({ product_name: "ทุเรียนเทศขนาดใหญ่", quantity: 5, unit: "กก." }),
      row({ product_name: "ผักเชียงดา", quantity: 4, unit: "กก." }),
      row({ product_name: "ชะนีไข่", quantity: 3, unit: "กก." }),
    ]);

    expect(productIn(summary, "ผลไม้", "ทุเรียนเทศขนาดใหญ่")?.quantity).toBe(5);
    expect(productIn(summary, "ทุเรียน", "ทุเรียนเทศขนาดใหญ่")).toBeUndefined();
    expect(productIn(summary, "ผัก", "ผักเชียงดา")?.quantity).toBe(4);
    expect(productIn(summary, "ทุเรียน", "ชะนีไข่")?.quantity).toBe(3);
  });

  test("unmodeled or disabled runtime entries keep the legacy wet-market category", async () => {
    await preload([
      ["ห901", "ห", "เห็ด"],
      ["ม902", "ม", "หลงลับแล", false],
    ]);

    const summary = buildStockSummaryFromRows(DATE, [
      row({ product_name: "เห็ด", quantity: 2, unit: "กก." }),
      row({ product_name: "หลงลับแล", quantity: 1, unit: "กก." }),
    ]);

    expect(productIn(summary, "ผัก", "เห็ด")?.quantity).toBe(2);
    expect(productIn(summary, "ทุเรียน", "หลงลับแล")?.quantity).toBe(1);
  });
});

describe("unidentified markets", () => {
  test("are reported separately, never folded into all-market totals", () => {
    const summary = buildStockSummaryFromRows(DATE, [
      row({ market_name: MARKET_A, quantity: 20 }),
      row({ market_name: "รายการชั่งเบิก", quantity: 500 }),
    ]);

    expect(productIn(summary, "ผลไม้", "แตงโม")?.quantity).toBe(20);
    expect(summary.unidentified.flatMap((g) => g.products)[0]?.quantity).toBe(500);
  });
});

describe("shared model", () => {
  test("the manual all-market reply embeds exactly the shared StockSummary blocks", () => {
    const rows = [
      row({ market_name: MARKET_A, product_name: "หมอนทอง", quantity: 200, unit: "โล" }),
      row({ market_name: MARKET_B, product_name: "แตงโม", quantity: 30, unit: "ลูก" }),
      row({ market_name: MARKET_B, product_name: "แก้วมังกร", quantity: 9, unit: "โล", transaction_type: TX_WITHDRAW }),
    ];

    const manual = buildRemainingFruitMessagesFromRows(DATE, rows).join("\n\n");
    const shared = buildStockSummaryBlocks(buildStockSummaryFromRows(DATE, rows)).join("\n\n");

    expect(manual.startsWith(shared)).toBe(true);
  });

  test("market-filtered command keeps the detail-only format", () => {
    const rows = [
      row({ market_name: MARKET_A, quantity: 20 }),
      row({ market_name: MARKET_B, quantity: 15 }),
    ];

    const messages = buildRemainingFruitMessagesFromRows(DATE, rows, {
      marketFilter: MARKET_A,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("เหลือขายต่อ:");
    expect(messages[0]).not.toContain("📦");
    expect(messages[0]).not.toContain("🍉");
  });
});
