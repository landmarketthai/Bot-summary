import { isSoldOutByAbsentReturn, type SalesReport } from "@/lib/sales/calculate";
import type { SalesValueStatus } from "@/lib/sales/calculate";
import { PRODUCT_CODE_ENTRIES } from "@/lib/produce/product-code/dictionary";
import { canonicalProduceProductIdentity } from "@/lib/produce/product-vocabulary";
import type {
  PurchasePlanningReport,
  PurchaseStatus,
  PurchaseUncertaintyReason,
} from "@/lib/summary/purchase-planning";
import { stockCategoryFor } from "@/lib/summary/stock-categories";

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
  /** ของดีชั่งคืนที่ยังอยู่ฝั่งตลาดและพร้อมขายต่อวันถัดไป */
  marketStockQuantity?: number;
  /** ของที่ยังอยู่บ้าน/คลังหลังเบิก; null เมื่อไม่มี snapshot ที่เชื่อถือได้ */
  houseStockQuantity?: number | null;
  /** marketStockQuantity + houseStockQuantity; null เมื่อฝั่งบ้านยังไม่ทราบ */
  totalRemainingQuantity?: number | null;
}

export interface MorningBriefPurchaseGroup {
  count: number;
  productNames: string[];
  items?: MorningBriefPurchaseItem[];
}

export type MorningBriefPurchasePlanning = Record<PurchaseStatus, MorningBriefPurchaseGroup>;

export function morningBriefProductIdentity(productName: string, unit: string): {
  productName: string;
  category: string;
} {
  const canonical = canonicalProduceProductIdentity(productName, unit);
  return {
    productName: canonical,
    category: CATEGORY_BY_PRODUCT.get(canonical) ?? stockCategoryFor(canonical),
  };
}

/** Keep every classified item; LINE/PDF presentation decides display size. */
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
      marketStockQuantity: item.goodReturnQuantity,
      houseStockQuantity: item.houseStockQuantity,
      totalRemainingQuantity: item.nextDayGoodStockQuantity,
    });
  }

  return summary;
}

export interface MorningBriefSalesReviewItem {
  marketLabel: string;
  productName: string;
  unit: string;
  status: string;
  valueStatus: SalesValueStatus;
  reasons: string[];
  soldQuantity: number | null;
  enteredPriceSatang: number | null;
  centralPriceSatang: number | null;
  confirmedSalesSatang: number | null;
  pendingReviewSalesSatang: number | null;
  adjustmentSatang: number;
  returnEvidenceIncomplete: boolean;
}

export interface MorningBriefSalesMarket {
  marketLabel: string;
  totalSalesSatang: number;
  confirmedSalesSatang: number;
  pendingReviewSalesSatang: number;
  adjustmentSatang: number;
  valueAuthoritative: boolean;
  trustedCount: number;
  unresolvedCount: number;
  soldOutCount: number;
  priceIssueCount: number;
  incompleteReturnIssueCount: number;
  excludedFromSalesCount: number;
}

export interface MorningBriefSales {
  totalSalesSatang: number;
  confirmedSalesSatang: number;
  pendingReviewSalesSatang: number;
  adjustmentSatang: number;
  valueAuthoritative: boolean;
  trustedCount: number;
  unresolvedCount: number;
  soldOutCount: number;
  priceConflictCount: number;
  priceConflictMarketCount: number;
  priceIssueCount: number;
  incompleteReturnIssueCount: number;
  excludedFromSalesCount: number;
  reviewItems?: MorningBriefSalesReviewItem[];
  markets?: MorningBriefSalesMarket[];
}

/** Read headline facts from SalesReport; never recalculate sales or sold-out rules. */
export function summarizeSales(report: SalesReport): MorningBriefSales {
  let soldOutCount = 0;
  let priceConflictCount = 0;
  const conflictMarkets = new Set<string>();
  const rows = report.markets.flatMap((market) => market.rows);

  const hasPriceIssue = (reasons: readonly string[]) =>
    reasons.includes("central_price_conflict") || reasons.includes("missing_central_price");
  const hasReturnIssue = (row: (typeof rows)[number]) =>
    row.reasons.includes("product_return_absent") || Boolean(row.returnEvidenceIncomplete);

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
    totalSalesSatang: report.allMarkets.totalSalesSatang,
    confirmedSalesSatang: report.allMarkets.expectedSalesSatang,
    pendingReviewSalesSatang: report.allMarkets.pendingReviewSalesSatang,
    adjustmentSatang: report.allMarkets.adjustmentSatang,
    valueAuthoritative: report.allMarkets.valueAuthoritative,
    trustedCount: report.allMarkets.trustedRowCount,
    unresolvedCount: report.allMarkets.valueBlockedRowCount + report.allMarkets.quantityBlockedRowCount,
    soldOutCount,
    priceConflictCount,
    priceConflictMarketCount: conflictMarkets.size,
    priceIssueCount: rows.filter((row) => hasPriceIssue(row.reasons)).length,
    incompleteReturnIssueCount: rows.filter(hasReturnIssue).length,
    excludedFromSalesCount: rows.filter((row) => row.valueStatus === "UNAVAILABLE").length,
    markets: report.markets.map((market) => ({
      marketLabel: market.marketLabel,
      totalSalesSatang: market.total.totalSalesSatang,
      confirmedSalesSatang: market.total.expectedSalesSatang,
      pendingReviewSalesSatang: market.total.pendingReviewSalesSatang,
      adjustmentSatang: market.total.adjustmentSatang,
      valueAuthoritative: market.total.valueAuthoritative,
      trustedCount: market.total.trustedRowCount,
      unresolvedCount: market.total.valueBlockedRowCount + market.total.quantityBlockedRowCount,
      soldOutCount: market.rows.filter(isSoldOutByAbsentReturn).length,
      priceIssueCount: market.rows.filter((row) => hasPriceIssue(row.reasons)).length,
      incompleteReturnIssueCount: market.rows.filter(hasReturnIssue).length,
      excludedFromSalesCount: market.rows.filter((row) => row.valueStatus === "UNAVAILABLE").length,
    })),
    reviewItems: rows.filter((row) => row.status !== "TRUSTED" || row.returnEvidenceIncomplete).map((row) => ({
      marketLabel: row.marketLabel,
      productName: morningBriefProductIdentity(row.productName, row.unit).productName,
      unit: row.unit,
      status: row.status,
      valueStatus: row.valueStatus,
      reasons: [...row.reasons],
      soldQuantity: row.soldQuantity,
      enteredPriceSatang: row.enteredPriceSatang,
      centralPriceSatang: row.centralPriceSatang,
      confirmedSalesSatang: row.expectedSalesSatang,
      pendingReviewSalesSatang: row.pendingReviewSalesSatang,
      adjustmentSatang: row.adjustmentSatang,
      returnEvidenceIncomplete: Boolean(row.returnEvidenceIncomplete),
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

export interface MorningBriefReconciliationRow {
  market: string;
  submittedTransferBaht: number | null;
  checkedSlipBaht: number | null;
  differenceBaht: number | null;
  status: "matched" | "transfer_short" | "transfer_over" | "pending_review" | "missing_data";
}

export type MorningBriefReconciliation =
  | {
      status: "available";
      submittedTransferBaht: number;
      checkedSlipBaht: number;
      differenceBaht: number;
      needsReviewCount: number;
      rows: MorningBriefReconciliationRow[];
    }
  | { status: "missing" }
  | { status: "unavailable" };

export interface MorningBriefFruitMarketSummary {
  marketLabel: string;
  withdrawalValueSatang: number;
  salesValueSatang: number;
  goodReturnValueSatang: number;
}

export interface MorningBriefFruitFinancialSummary {
  withdrawalValueSatang: number;
  salesValueSatang: number;
  goodReturnValueSatang: number;
  houseStockValueSatang: number | null;
  readyValueSatang: number | null;
  markets: MorningBriefFruitMarketSummary[];
}

export interface MorningBriefReport {
  businessDate: string;
  purchasePlanning: MorningBriefPurchasePlanning;
  sales: MorningBriefSales;
  houseStock: MorningBriefHouseStock;
  fruitFinancial?: MorningBriefFruitFinancialSummary;
  reconciliation?: MorningBriefReconciliation;
}
