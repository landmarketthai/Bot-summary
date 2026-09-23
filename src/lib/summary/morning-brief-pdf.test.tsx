import React from "react";
import { describe, expect, test } from "bun:test";
import { renderToBuffer } from "@react-pdf/renderer";
import { registerFonts } from "@/lib/pdf/fonts";
import { MorningBriefA4Doc } from "@/lib/pdf/MorningBriefA4Doc";
import type { MorningBriefReport } from "@/lib/summary/morning-brief";
import {
  morningBriefPdfFilename,
  morningBriefPdfLineMessage,
  morningBriefPdfPath,
} from "@/lib/summary/morning-brief-pdf";

const report: MorningBriefReport = {
  businessDate: "2026-09-19",
  purchasePlanning: {
    strong: {
      count: 2,
      productNames: ["พุทราจีน", "แอปเปิ้ล"],
      items: [
        { productName: "พุทราจีน", originalProductName: null, category: "ผลไม้", unit: "โล", uncertaintyReasons: [], marketStockQuantity: 10.1, houseStockQuantity: 0, totalRemainingQuantity: 10.1 },
        { productName: "แอปเปิ้ล", originalProductName: null, category: "ผลไม้", unit: "ลูก", uncertaintyReasons: [], marketStockQuantity: 372, houseStockQuantity: 40, totalRemainingQuantity: 412 },
      ],
    },
    surplus: { count: 1, productNames: ["แก้วมังกร"], items: [{ productName: "แก้วมังกร", originalProductName: null, category: "ผลไม้", unit: "โล", uncertaintyReasons: [], marketStockQuantity: 170, houseStockQuantity: 0, totalRemainingQuantity: 170 }] },
    reduce: { count: 1, productNames: ["สาลี่หิมะ"] },
    unknown: { count: 0, productNames: [] },
  },
  sales: {
    totalSalesSatang: 130456,
    confirmedSalesSatang: 123456,
    pendingReviewSalesSatang: 7000,
    adjustmentSatang: -500,
    valueAuthoritative: true,
    trustedCount: 12,
    unresolvedCount: 1,
    soldOutCount: 2,
    priceConflictCount: 0,
    priceConflictMarketCount: 0,
    priceIssueCount: 1,
    incompleteReturnIssueCount: 0,
    excludedFromSalesCount: 0,
  },
  houseStock: {
    status: "available",
    groupCount: 5,
    totalValueSatang: 580400,
  },
  fruitFinancial: {
    withdrawalValueSatang: 8_680_866,
    salesValueSatang: 2_251_158,
    goodReturnValueSatang: 6_075_583,
    houseStockValueSatang: 1_003_320,
    readyValueSatang: 7_078_903,
    markets: [
      { marketLabel: "ทรัพย์พันธ์2", withdrawalValueSatang: 1_215_216, salesValueSatang: 294_229, goodReturnValueSatang: 887_550 },
      { marketLabel: "พาซิโอ้ผลไม้", withdrawalValueSatang: 1_722_917, salesValueSatang: 302_505, goodReturnValueSatang: 1_360_300 },
    ],
  },
};

function collectText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (React.isValidElement(node)) {
    const element = node as React.ReactElement<Record<string, unknown>>;
    if (typeof element.type === "function") {
      return collectText((element.type as (props: Record<string, unknown>) => React.ReactNode)(element.props));
    }
    return collectText((element.props as { children?: React.ReactNode }).children);
  }
  return "";
}

describe("Morning Brief A4 PDF", () => {
  test("uses a deterministic date-based filename and path", () => {
    expect(morningBriefPdfFilename("2026-09-19")).toBe("morning-brief-2026-09-19.pdf");
    expect(morningBriefPdfPath("2026-09-19")).toBe("2026-09-19/morning-brief-2026-09-19.pdf");
  });

  test("LINE download message contains the signed URL and expiry hint", () => {
    const text = morningBriefPdfLineMessage("https://example.test/signed.pdf");
    expect(text).toContain("PDF สำหรับพิมพ์ A4");
    expect(text).toContain("https://example.test/signed.pdf");
    expect(text).toContain("7 วัน");
  });

  test("shows yesterday sales total in the top KPI row", () => {
    const text = collectText(MorningBriefA4Doc({ report, generatedAt: new Date("2026-09-19T08:00:00+07:00") }));
    expect(text).toContain("ยอดขายรวมเมื่อวาน");
    expect(text).toContain("22,511.58");
  });

  test("uses the requested stock columns and remaps house, market, then total", () => {
    const layoutReport: MorningBriefReport = { ...report, businessDate: "2026-09-22" };
    const text = collectText(MorningBriefA4Doc({ report: layoutReport, generatedAt: new Date("2026-09-23T08:00:00+07:00") }));
    const normalized = text.replace(/\s+/g, " ").trim();
    expect(normalized).toContain("ตารางผลไม้คงเหลือสำหรับสั่งซื้อ - 22 กันยายน 2569");

    expect(normalized).toContain("รายการ คงเหลือในบ้าน ในตลาด รวมคงเหลือ");

    const apple = text.indexOf("แอปเปิ้ล");
    const house = text.indexOf("40", apple);
    const market = text.indexOf("372", house);
    const total = text.indexOf("412", market);
    expect(apple).toBeGreaterThanOrEqual(0);
    expect(house).toBeGreaterThan(apple);
    expect(market).toBeGreaterThan(house);
    expect(total).toBeGreaterThan(market);
    expect(text).not.toContain("บ้านเจ๊");
  });

  test("renders the fruit summary page followed by the stock matrix page", async () => {
    registerFonts();
    const buffer = await renderToBuffer(
      <MorningBriefA4Doc report={report} generatedAt={new Date("2026-09-19T08:00:00+07:00")} />,
    );
    expect(buffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(5_000);
    expect((buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(2);
  });
});
