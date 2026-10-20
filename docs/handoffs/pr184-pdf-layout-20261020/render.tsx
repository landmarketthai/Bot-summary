import { renderToBuffer } from "@react-pdf/renderer";
import { MorningBriefA4Doc } from "../../../src/lib/pdf/MorningBriefA4Doc";
import { registerFonts } from "../../../src/lib/pdf/fonts";
import type { MorningBriefReport } from "../../../src/lib/summary/morning-brief";
import { PRODUCT_CODE_ENTRIES } from "../../../src/lib/produce/product-code/dictionary";

const root = import.meta.dir;
const load = (name: string): Promise<MorningBriefReport> =>
  Bun.file(`${root}/../pr184-uat-20261020/${name}.report.json`).json();
const before = await load("before-return");
const after = await load("after-return");
const empty = { count: 0, productNames: [], items: [] };

// Synthetic stress data exercises presentation only; the two UAT snapshots stay untouched.
function stress(markets: number, fruit: number, vegetable: number, other: number): MorningBriefReport {
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

registerFonts();
for (const [name, report] of Object.entries({ "before-return": before, "after-return": after,
  "multi-market": stress(3, 6, 3, 2), "overflow": stress(30, 48, 12, 4) })) {
  const snapshot = JSON.stringify(report);
  const pdf = await renderToBuffer(MorningBriefA4Doc({ report, generatedAt: new Date("2026-10-20T12:15:00+07:00") }));
  if (JSON.stringify(report) !== snapshot) throw new Error(`${name}: renderer mutated input`);
  await Bun.write(`${root}/pdf/${name}.pdf`, pdf);
  if (name === "multi-market" || name === "overflow") await Bun.write(`${root}/${name}.report.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(name, "pages", (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length);
}
