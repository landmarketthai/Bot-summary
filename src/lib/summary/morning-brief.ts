import { isSoldOutByAbsentReturn, type SalesReport } from "@/lib/sales/calculate";
import { PRODUCT_CODE_ENTRIES } from "@/lib/produce/product-code/dictionary";
import { canonicalProduceProductIdentity } from "@/lib/produce/product-vocabulary";
import type {
  PurchasePlanningReport,
  PurchaseStatus,
  PurchaseUncertaintyReason,
} from "@/lib/summary/purchase-planning";

const CATEGORY_BY_PRODUCT = new Map(
  PRODUCT_CODE_ENTRIES
    .filter((entry) => entry.enabled)
    .map((entry) => [entry.canonicalName, entry.category] as const),
);

export interface MorningBriefPurchaseItem {
  productName: string;
  originalProductName: string | null;
  category: string;
  unit: string;
  uncertaintyReasons: PurchaseUncertaintyReason[];
}

export interface MorningBriefPurchaseGroup {
  count: number;
  productNames: string[];
  items?: MorningBriefPurchaseItem[];
}
export type MorningBriefPurchasePlanning = Record<
  PurchaseStatus,
  MorningBriefPurchaseGroup
>;

export function morningBriefProductIdentity(productName: string, unit: string): {
  productName: string;
  category: string;
} {
  const canonical = canonicalProduceProductIdentity(productName, unit);
  return {
    productName: canonical,
    category: CATEGORY_BY_PRODUCT.get(canonical) ?? "อื่นๆ / ยังไม่เข้าหมวด",
  };
}

/** Keep every classified item; LINE chunking decides presentation size later. */
export function summarizePurchasePlanning(
  report: Pick<PurchasePlanningReport, "items">,
): MorningBriefPurchasePlanning {
  const empty = (): MorningBriefPurchaseGroup => ({ count: 0, productNames: [], items: [] });
  const summary: MorningBriefPurchasePlanning = {
    strong: empty(), surplus: empty(), reduce: empty(), unknown: empty(),
  };

  for (const item of report.items) {
    const group = summary[item.status];
    const identity = morningBriefProductIdentity(item.productName, item.unit);
    group.count += 1;
    group.productNames.push(identity.productName);
    group.items!.push({
      productName: identity.productName,
      originalProductName: identity.productName === item.productName ? null : item.productName,
      category: identity.category,
      unit: item.unit,
      uncertaintyReasons: [...item.uncertaintyReasons],
    });
  }

  return summary;
}

export interface MorningBriefSalesReviewItem {
  marketLabel: string;
  productName: string;
  unit: string;
  status: string;
  reasons: string[];
}

export interface MorningBriefSales {
  confirmedSalesSatang: number;
  valueAuthoritative: boolean;
  trustedCount: number;
  unresolvedCount: number;
  soldOutCount: number;
  priceConflictCount: number;
  priceConflictMarketCount: number;
  reviewItems?: MorningBriefSalesReviewItem[];
}

/** Read headline facts from SalesReport; never recalculate sales or sold-out rules. */
export function summarizeSales(report: SalesReport): MorningBriefSales {
  let soldOutCount = 0;
  let priceConflictCount = 0;
  const conflictMarkets = new Set<string>();

  for (const market of report.markets) {
    for (const row of market.rows) {
      if (isSoldOutByAbsentReturn(row)) soldOutCount += 1;
      if (row.reasons.includes("central_price_conflict")) {
        priceConflictCount += 1;
        conflictMarkets.add(row.marketKey);
      }
    }
  }

  return {
    confirmedSalesSatang: report.allMarkets.expectedSalesSatang,
    valueAuthoritative: report.allMarkets.valueAuthoritative,
    trustedCount: report.allMarkets.trustedRowCount,
    unresolvedCount:
      report.allMarkets.valueBlockedRowCount + report.allMarkets.quantityBlockedRowCount,
    soldOutCount,
    priceConflictCount,
    priceConflictMarketCount: conflictMarkets.size,
    reviewItems: report.blocked.map((row) => ({
      marketLabel: row.marketLabel,
      productName: morningBriefProductIdentity(row.productName, row.unit).productName,
      unit: row.unit,
      status: row.status,
      reasons: [...row.reasons],
    })),
  };
}

export interface MorningBriefHouseStockItem {
  productName: string;
  category: string;
  unit: string;
  quantity: number;
  unitPriceSatang: number;
  valueSatang: number;
}

export type MorningBriefHouseStock =
  | { status: "available"; groupCount: number; totalValueSatang: number; items?: MorningBriefHouseStockItem[] }
  | { status: "missing" }
  | { status: "unavailable" };

export interface MorningBriefReport {
  businessDate: string;
  purchasePlanning: MorningBriefPurchasePlanning;
  sales: MorningBriefSales;
  houseStock: MorningBriefHouseStock;
}
