import {
  runtimeProductCodeEntryForName,
  type RuntimeDictionarySnapshot,
} from "@/lib/produce/product-code/resolver";
import {
  buildRemainingFruitReport,
  UNIDENTIFIED_MARKET_SECTION,
  type RemainingFruitItem,
  type RemainingFruitMarketSection,
  type RemainingFruitReport,
  type RemainingFruitSourceRow,
} from "@/lib/summary/remaining-fruit";
import {
  explicitStockCategoryFor,
  stockCategoryFor,
  STOCK_CATEGORY_ORDER,
  UNCATEGORIZED,
  type StockCategory,
} from "@/lib/summary/stock-categories";

/**
 * StockSummary is the single business model behind BOTH the manual
 * `สรุปคงเหลือ` LINE command and the scheduled daily delivery. There is
 * exactly one calculation path: rows → buildRemainingFruitReport →
 * buildStockSummary. Never re-derive stock numbers anywhere else.
 *
 * Semantics (daily return stock, NOT a perpetual inventory ledger):
 *   - "เหลือขายต่อ" is the summed good return (ชั่งคืน / transaction_type "คืน").
 *   - คืนเสีย is damage. It is never sellable stock and never reduces or
 *     substitutes for a good return.
 *   - A withdrawal with no good return is NOT remaining = 0. It is reported as
 *     incomplete (ยังไม่มีข้อมูลชั่งคืน) so a human knows the day is not closed.
 *   - No opening balance, no purchase intake, no carry-forward, no cost.
 *   - Voided sessions never reach here: produce_transactions is defined as
 *     produce_transactions_all WHERE voided_at IS NULL (migration 0037).
 */

export interface StockProductTotal {
  productName: string;
  unit: string;
  /** Summed good return across every contributing market. */
  quantity: number;
  markets: Array<{ marketName: string; quantity: number }>;
}

export interface StockCategoryGroup {
  category: StockCategory;
  products: StockProductTotal[];
}

/** One market + canonical product + unit whose good return is still missing. */
export interface StockIncompleteEntry {
  marketName: string;
  productName: string;
  unit: string;
  withdrawnQuantity: number;
}

export interface StockSummary {
  businessDate: string;
  /** Categories in STOCK_CATEGORY_ORDER; empty categories are omitted. */
  categories: StockCategoryGroup[];
  /** market + product + unit combinations still awaiting ชั่งคืน. */
  incomplete: StockIncompleteEntry[];
  /** False whenever any required good return is missing. */
  isComplete: boolean;
  /** Markets whose name could not be resolved — surfaced, never dropped. */
  unidentified: StockCategoryGroup[];
  /** Per-market detail, passed through untouched for the existing detail path. */
  detail: RemainingFruitReport;
}

function hasSellableStock(item: RemainingFruitItem): boolean {
  return item.hasReturnGoodData && item.remainingForResaleQuantity > 0;
}

/**
 * A product is incomplete when the market withdrew it but no good return has
 * been recorded for that exact product + unit. คืนเสีย alone does not close
 * the loop: damage is not a good return.
 */
function isIncomplete(item: RemainingFruitItem): boolean {
  return item.hasWithdrawnData && !item.hasReturnGoodData;
}

/**
 * Runtime dictionary category codes the Stock model represents directly.
 * ป / ห / พ are absent on purpose: they keep an exact legacy wet-market mapping.
 */
const STOCK_CATEGORY_BY_RUNTIME_CODE: ReadonlyMap<string, StockCategory> = new Map([
  ["ท", "ทุเรียน"],
  ["ม", "ผลไม้"],
  ["ผ", "ผัก"],
]);

/**
 * An enabled runtime dictionary entry is authoritative, so a DB-only product
 * such as ทุเรียนเทศขนาดใหญ่ (ม) is never filed as durian by the substring
 * rule. A code the Stock model does not represent (ป / ห / พ) keeps only an
 * exact legacy mapping (เห็ด stays ผัก) and is otherwise ไม่จัดหมวด — visible,
 * never guessed. With no usable entry the legacy mapping applies.
 * `runtimeDictionary` is the snapshot the caller preloaded; omitted, the
 * current process-wide one.
 */
function categoryFor(productName: string, runtimeDictionary?: RuntimeDictionarySnapshot): StockCategory {
  const entry = runtimeProductCodeEntryForName(productName, runtimeDictionary);
  if (!entry) return stockCategoryFor(productName);
  return STOCK_CATEGORY_BY_RUNTIME_CODE.get(entry.categoryCode)
    ?? explicitStockCategoryFor(productName)
    ?? UNCATEGORIZED;
}

function groupByCategory(
  sections: RemainingFruitMarketSection[],
  runtimeDictionary?: RuntimeDictionarySnapshot,
): StockCategoryGroup[] {
  const byCategory = new Map<StockCategory, Map<string, StockProductTotal>>();

  for (const section of sections) {
    for (const item of section.items) {
      if (!hasSellableStock(item)) continue;

      const category = categoryFor(item.fruitName, runtimeDictionary);
      let products = byCategory.get(category);
      if (!products) {
        products = new Map();
        byCategory.set(category, products);
      }

      // Unit stays in the key: กก. and กล่อง of the same product never merge.
      const key = `${item.fruitName}||${item.unit}`;
      let total = products.get(key);
      if (!total) {
        total = { productName: item.fruitName, unit: item.unit, quantity: 0, markets: [] };
        products.set(key, total);
      }

      total.quantity += item.remainingForResaleQuantity;
      total.markets.push({
        marketName: section.marketName,
        quantity: item.remainingForResaleQuantity,
      });
    }
  }

  const groups: StockCategoryGroup[] = [];
  for (const category of STOCK_CATEGORY_ORDER) {
    const products = byCategory.get(category);
    if (!products || products.size === 0) continue;

    groups.push({
      category,
      products: [...products.values()]
        .map((product) => ({
          ...product,
          markets: product.markets.sort((a, b) => a.marketName.localeCompare(b.marketName, "th")),
        }))
        // Biggest remaining first — that is the purchasing decision order.
        .sort(
          (a, b) =>
            b.quantity - a.quantity ||
            a.productName.localeCompare(b.productName, "th") ||
            a.unit.localeCompare(b.unit, "th"),
        ),
    });
  }

  return groups;
}

function collectIncomplete(sections: RemainingFruitMarketSection[]): StockIncompleteEntry[] {
  const entries: StockIncompleteEntry[] = [];

  for (const section of sections) {
    for (const item of section.items) {
      if (!isIncomplete(item)) continue;
      entries.push({
        marketName: section.marketName,
        productName: item.fruitName,
        unit: item.unit,
        withdrawnQuantity: item.withdrawnQuantity,
      });
    }
  }

  return entries.sort(
    (a, b) =>
      a.marketName.localeCompare(b.marketName, "th") ||
      a.productName.localeCompare(b.productName, "th") ||
      a.unit.localeCompare(b.unit, "th"),
  );
}

export function buildStockSummary(
  businessDate: string,
  report: RemainingFruitReport,
  runtimeDictionary?: RuntimeDictionarySnapshot,
): StockSummary {
  const unidentifiedSections = report.unidentified?.markets ?? [];
  // Unidentified-market rows are reported separately so they are never double
  // counted into the all-market totals, and never silently dropped either.
  const incomplete = [
    ...collectIncomplete(report.markets),
    ...collectIncomplete(unidentifiedSections),
  ].sort(
    (a, b) =>
      a.marketName.localeCompare(b.marketName, "th") ||
      a.productName.localeCompare(b.productName, "th") ||
      a.unit.localeCompare(b.unit, "th"),
  );

  return {
    businessDate,
    categories: groupByCategory(report.markets, runtimeDictionary),
    incomplete,
    isComplete: incomplete.length === 0,
    unidentified: groupByCategory(unidentifiedSections, runtimeDictionary),
    detail: report,
  };
}

/** Single entry point from raw produce rows to the shared StockSummary model. */
export function buildStockSummaryFromRows(
  businessDate: string,
  rows: readonly RemainingFruitSourceRow[],
  options: { marketFilter?: string | null; runtimeDictionary?: RuntimeDictionarySnapshot } = {},
): StockSummary {
  const report = buildRemainingFruitReport(rows, { marketFilter: options.marketFilter });
  return buildStockSummary(businessDate, report, options.runtimeDictionary);
}

export { UNIDENTIFIED_MARKET_SECTION };
