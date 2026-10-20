import type { MorningBriefReport } from "../../../src/lib/summary/morning-brief";
import { PRODUCT_CODE_ENTRIES } from "../../../src/lib/produce/product-code/dictionary";

const empty = { count: 0, productNames: [], items: [] };

// Synthetic stress data exercises presentation only; the two UAT snapshots stay untouched.
export function morningBriefLayoutFixture(after: MorningBriefReport, markets: number, fruit: number, vegetable: number, other: number): MorningBriefReport {
  const items = [
    ...PRODUCT_CODE_ENTRIES.filter(item => item.enabled && item.category === "ผลไม้").slice(0, fruit)
      .map(item => ({ productName: item.canonicalName, category: "ผลไม้" })),
    ...PRODUCT_CODE_ENTRIES.filter(item => item.enabled && item.category === "ผัก / สมุนไพร / เครื่องประกอบอาหาร").slice(0, vegetable)
      .map(item => ({ productName: item.canonicalName, category: "ผัก" })),
    ...Array.from({ length: other }, (_, i) => ({ productName: `สินค้าทดสอบ${i + 1} ชื่อยาวพิเศษสำหรับตรวจวรรณยุกต์และการตัดบรรทัด`, category: "อื่นๆ" })),
  ].map((item, i) => ({ ...item, originalProductName: null, unit: i % 2 ? "ลูก" : "โล",
    uncertaintyReasons: [], marketStockQuantity: i + 0.125, houseStockQuantity: 1,
    totalRemainingQuantity: i + 1.125 }));
  const money = (value: number) => ({ withdrawalValueSatang: value * 3, salesValueSatang: value,
    goodReturnValueSatang: value * 2, houseStockValueSatang: value, readyValueSatang: value * 3,
    markets: Array.from({ length: markets }, (_, i) => ({ marketLabel: `ตลาดทดสอบ${i + 1}`,
      withdrawalValueSatang: value * 3 / markets, salesValueSatang: value / markets,
      goodReturnValueSatang: value * 2 / markets })) });
  return { ...after, produceFinancial: { fruit: money(markets * 1000), vegetable: money(markets * 500), other: money(markets * 100) },
    fruitFinancial: money(markets * 1000),
    sales: { ...after.sales, confirmedSalesSatang: markets * 1600, totalSalesSatang: markets * 1600,
      pendingReviewSalesSatang: 0, adjustmentSatang: 0, excludedFromSalesCount: 0, valueAuthoritative: true,
      markets: Array.from({ length: markets }, (_, i) => ({ marketLabel: `ตลาดทดสอบ${i + 1}`,
        totalSalesSatang: 1600, confirmedSalesSatang: 1600, pendingReviewSalesSatang: 0,
        awaitingReturnCount: 0, excludedFromSalesCount: 0, adjustmentSatang: 0, valueAuthoritative: true,
        trustedCount: 1, unresolvedCount: 0, soldOutCount: 0, priceIssueCount: 0, incompleteReturnIssueCount: 0 })) },
    produceReadiness: { ...after.produceReadiness!, markets: Array.from({ length: markets }, (_, i) => ({
      marketLabel: `ตลาดทดสอบ${i + 1}`, hasWithdrawal: true, hasReturn: true,
    })) },
    purchasePlanning: { strong: { count: items.length, productNames: items.map(item => item.productName), items },
      surplus: empty, reduce: empty, unknown: empty }, houseStock: { status: "missing" } };
}
