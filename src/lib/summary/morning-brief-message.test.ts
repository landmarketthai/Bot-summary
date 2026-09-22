import { describe, expect, test } from "bun:test";
import type {
  MorningBriefPurchaseGroup,
  MorningBriefPurchaseItem,
  MorningBriefReport,
} from "./morning-brief";
import { countCodePoints } from "./line-chunking";
import { MorningBriefA4Doc } from "@/lib/pdf/MorningBriefA4Doc";
import { buildMorningBriefMessage, buildMorningBriefMessages } from "./morning-brief-message";

const BUSINESS_DATE = "2026-08-27";

function purchaseItems(
  prefix: string,
  count: number,
  category = "ผัก / สมุนไพร / เครื่องประกอบอาหาร",
  reasons: MorningBriefPurchaseItem["uncertaintyReasons"] = [],
): MorningBriefPurchaseItem[] {
  return Array.from({ length: count }, (_, index) => ({
    productName: `${prefix}${index + 1}`,
    originalProductName: null,
    category,
    unit: "แพค",
    uncertaintyReasons: [...reasons],
  }));
}

function group(items: MorningBriefPurchaseItem[]): MorningBriefPurchaseGroup {
  return { count: items.length, productNames: items.map((item) => item.productName), items };
}
function report(overrides: Partial<MorningBriefReport> = {}): MorningBriefReport {
  const strong = purchaseItems("ซื้อ", 12, "ผลไม้");
  return {
    businessDate: BUSINESS_DATE,
    purchasePlanning: {
      strong: group(strong),
      surplus: group(purchaseItems("รอ", 2, "ผลไม้")),
      reduce: group(purchaseItems("ลด", 2, "ผลไม้")),
      unknown: group(purchaseItems("ตรวจ", 2, "ผลไม้", ["return_incomplete"])),
    },
    sales: {
      totalSalesSatang: 2_246_074,
      confirmedSalesSatang: 2_174_074,
      pendingReviewSalesSatang: 72_000,
      adjustmentSatang: -1_000,
      valueAuthoritative: false,
      trustedCount: 77,
      unresolvedCount: 3,
      soldOutCount: 50,
      priceConflictCount: 2,
      priceConflictMarketCount: 2,
      priceIssueCount: 2,
      incompleteReturnIssueCount: 1,
      excludedFromSalesCount: 1,
      reviewItems: [
        { marketLabel: "ตลาดเอ", productName: "มะละกอ", unit: "ลูก", status: "VALUE_BLOCKED", valueStatus: "PENDING_REVIEW", reasons: ["central_price_conflict"], soldQuantity: 2, enteredPriceSatang: 3500, centralPriceSatang: null, confirmedSalesSatang: null, pendingReviewSalesSatang: 7000, adjustmentSatang: 0, returnEvidenceIncomplete: false },
        { marketLabel: "ตลาดบี", productName: "มังคุด", unit: "โล", status: "VALUE_BLOCKED", valueStatus: "PENDING_REVIEW", reasons: ["central_price_conflict"], soldQuantity: 1, enteredPriceSatang: 6500, centralPriceSatang: null, confirmedSalesSatang: null, pendingReviewSalesSatang: 6500, adjustmentSatang: 0, returnEvidenceIncomplete: false },
        { marketLabel: "ตลาดเอ", productName: "สาลี่", unit: "ลูก", status: "QUANTITY_BLOCKED", valueStatus: "UNAVAILABLE", reasons: ["product_return_absent"], soldQuantity: null, enteredPriceSatang: 1000, centralPriceSatang: null, confirmedSalesSatang: null, pendingReviewSalesSatang: null, adjustmentSatang: 0, returnEvidenceIncomplete: true },
      ],
    },
    houseStock: {
      status: "available",
      groupCount: 1,
      totalValueSatang: 105_000,
      items: [{ productName: "มะละกอ", category: "ผลไม้", unit: "ลูก", quantity: 30, unitPriceSatang: 3500, valueSatang: 105_000 }],
    },
    ...overrides,
  };
}
describe("Morning Decision Brief", () => {
  test("shows every actionable fruit item and drops unknown items from LINE", () => {
    const message = buildMorningBriefMessage(report());
    expect(message).toContain("🟢 ควรซื้อเพิ่ม — 12 รายการ");
    expect(message).toContain("ผลไม้ — 12 รายการ");
    expect(message).toContain("ซื้อ12");
    expect(message).toContain("เกณฑ์ของเหลือพร้อมขาย = ชั่งคืนดี + Stock บ้าน");
    expect(message).not.toContain("ข้อมูลแผนซื้อยังไม่ครบ");
    expect(message).not.toContain("ตรวจ1");
    expect(message).not.toContain("+อีก");
  });

  test("shows the total only and hides the known price-review noise", () => {
    const message = buildMorningBriefMessage(report());
    expect(message).toContain("ยอดขายรวม 22,460.74 บาท");
    expect(message).not.toContain("รอตรวจราคา");
    expect(message).not.toContain("ยอดรอตรวจ");
    expect(message).not.toContain("ปรับราคา");
    expect(message).not.toContain("รอข้อมูลคืน/คืนเสีย");
  });

  test("does not dump sales review products, markets, or reason codes into LINE", () => {
    const message = buildMorningBriefMessage(report());
    expect(message).not.toContain("รายละเอียดรอตรวจ");
    expect(message).not.toContain("ตลาดเอ: มะละกอ");
    expect(message).not.toContain("สาลี่ (ลูก)");
    expect(message).not.toContain("central_price_conflict");
  });

  test("large sales error details stay compact and do not split the Morning Brief", () => {
    const base = report();
    const reviewItems = Array.from({ length: 300 }, (_, index) => ({
      ...base.sales.reviewItems![0]!,
      marketLabel: `market-${index}`,
      productName: `product-${index}`,
    }));
    const empty = group([]);
    const messages = buildMorningBriefMessages(report({
      purchasePlanning: { strong: empty, surplus: empty, reduce: empty, unknown: empty },
      sales: { ...base.sales, reviewItems },
      houseStock: { status: "missing" },
    }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain("รอตรวจราคา");
    expect(messages[0]).not.toContain("รอข้อมูลคืน/คืนเสีย");
    expect(messages[0]).not.toContain("product-299");
    expect(messages[0]).not.toContain("Part ");
  });
  test("shows House Stock product, quantity, price and value by category", () => {
    const message = buildMorningBriefMessage(report());
    expect(message).toContain("🏠 ของในบ้าน — 1 รายการ");
    expect(message).toContain("ผลไม้ — 1 รายการ");
    expect(message).toContain("มะละกอ — 30 ลูก • 35 บาท/ลูก • มูลค่า 1,050.00 บาท");
  });

  test("missing and unavailable House Stock degrade only their section", () => {
    const missing = buildMorningBriefMessage(report({ houseStock: { status: "missing" } }));
    const unavailable = buildMorningBriefMessage(report({ houseStock: { status: "unavailable" } }));
    expect(missing).toContain("ยังไม่มีข้อมูลสต๊อกบ้าน");
    expect(unavailable).toContain("ยังตรวจสต๊อกบ้านไม่ได้");
    expect(unavailable).not.toContain("⚠️");
  });
  test("large categorized lists chunk instead of truncating names", () => {
    const many = purchaseItems("สินค้า", 150);
    const messages = buildMorningBriefMessages(report({
      purchasePlanning: {
        strong: group(many),
        surplus: group([]),
        reduce: group([]),
        unknown: group([]),
      },
    }), { maxMessages: 10 });
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(countCodePoints(message)).toBeLessThanOrEqual(800);
      expect(message).toContain("Part ");
    }
    const joined = messages.join("\n");
    expect(joined).toContain("สินค้า150");
    expect(joined).not.toContain("+อีก");
  });

  test("zero counters and zero money lines are not shown", () => {
    const base = report();
    const empty = group([]);
    const message = buildMorningBriefMessage(report({
      purchasePlanning: { ...base.purchasePlanning, unknown: empty },
      sales: {
        ...base.sales,
        totalSalesSatang: 2_174_074,
        pendingReviewSalesSatang: 0,
        adjustmentSatang: 0,
        priceIssueCount: 0,
        incompleteReturnIssueCount: 0,
        excludedFromSalesCount: 0,
      },
    }));
    expect(message).toContain("💰 ภาพรวมเงิน\nยอดขายรวม 21,740.74 บาท");
    expect(message).not.toContain("ยอดรอตรวจ");
    expect(message).not.toContain("ปรับราคา");
    expect(message).not.toMatch(/ 0 รายการ/);
    expect(message).not.toContain("⚠️ ข้อมูลที่ต้องตรวจ");
  });

  test("does not export diagnostic counters to LINE", () => {
    const base = report();
    const message = buildMorningBriefMessage(report({
      purchasePlanning: {
        ...base.purchasePlanning,
        unknown: group(purchaseItems("ตรวจ", 1, "ผลไม้", ["return_incomplete"])),
      },
      sales: { ...base.sales, priceIssueCount: 4, incompleteReturnIssueCount: 3, excludedFromSalesCount: 0 },
    }));
    expect(message).not.toContain("⚠️ ข้อมูลที่ต้องตรวจ");
    expect(message).not.toContain("รอข้อมูลคืน/คืนเสีย");
    expect(message).not.toContain("ข้อมูลแผนซื้อยังไม่ครบ");
    expect(message).not.toContain("รอตรวจราคา");
  });
});

/** Every string a react-pdf element tree would render, without laying out a PDF. */
function pdfText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(pdfText).join("\n");
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (typeof element.type === "function") return pdfText((element.type as (props: unknown) => unknown)(element.props));
  return pdfText(element.props?.children);
}

describe("Morning Brief LINE layout — Production 2026-09-07 regression", () => {
  // Real failure: 98 actionable purchase items plus 14 dried-fish items whose
  // round return was incomplete pushed ยอดขาย to Part 5/5, behind 14 lines of
  // "รายการคืน/คืนเสียของรอบยังไม่สมบูรณ์".
  const unknownNames = Array.from({ length: 14 }, (_, index) => `ปลาแห้งรอคืน${index + 1}`);
  const heavy = report({
    purchasePlanning: {
      strong: group([
        ...purchaseItems("ผักซื้อเพิ่มชื่อยาว", 74),
        ...purchaseItems("ผลไม้ซื้อเพิ่ม", 6, "ผลไม้"),
      ]),
      surplus: group(purchaseItems("ผลไม้ยังไม่ซื้อ", 5, "ผลไม้")),
      reduce: group(purchaseItems("ผลไม้ลดซื้อ", 13, "ผลไม้")),
      unknown: group(unknownNames.map((productName) => ({
        productName,
        originalProductName: null,
        category: "ปลา / อาหารแห้ง / ของแห้ง",
        unit: "ถุง",
        uncertaintyReasons: ["return_incomplete" as const],
      }))),
    },
  });

  test("financial overview is in Part 1 even when the message splits", () => {
    const messages = buildMorningBriefMessages(heavy);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages[0]).toContain("Part 1/");
    expect(messages[0]).toContain("💰 ภาพรวมเงิน");
    expect(messages[0]).toContain("ยอดขายรวม 22,460.74 บาท");
    expect(messages[0]).not.toContain("ยอดรอตรวจ");
    const joined = messages.join("\n");
    expect(joined.indexOf("💰 ภาพรวมเงิน")).toBeLessThan(joined.indexOf("🛒 แผนซื้อผลไม้"));
    expect(joined).not.toContain("⚠️ ข้อมูลที่ต้องตรวจ");
    expect(joined).not.toContain("ข้อมูลแผนซื้อยังไม่ครบ");
  });

  test("incomplete-return diagnostics are not exported to LINE", () => {
    const joined = buildMorningBriefMessages(heavy).join("\n");
    expect(joined).not.toContain("ข้อมูลแผนซื้อยังไม่ครบ");
    expect(joined).not.toContain("รอข้อมูลคืน/คืนเสีย");
    expect(joined).not.toContain("รายการคืน/คืนเสียของรอบยังไม่สมบูรณ์");
    for (const name of unknownNames) expect(joined).not.toContain(name);
    expect(joined).not.toContain("ยังประเมินไม่ได้");
  });

  test("chunking limits still hold and actionable purchase names are not dropped", () => {
    const messages = buildMorningBriefMessages(heavy);
    for (const message of messages) expect(countCodePoints(message)).toBeLessThanOrEqual(800);
    expect(messages.join("\n")).toContain("ผักซื้อเพิ่มชื่อยาว74");
    expect(messages.join("\n")).not.toContain("รายละเอียดมากเกินขีดจำกัด LINE");
  });

  test("the PDF carries the final stock-basis wording and no price-review noise", () => {
    const text = pdfText(MorningBriefA4Doc({ report: heavy, generatedAt: new Date("2026-09-08T01:00:00Z") }));
    for (const name of unknownNames) expect(text).toContain(name);
    expect(text).toContain("คงเหลือพร้อมขาย (ชั่งคืนดี + บ้าน)");
    expect(text).toContain("องุ่นแดง (ลูก)");
    expect(text).toContain("องุ่นแดง (โล)");
    expect(text).not.toContain("รอตรวจราคา");
  });
});
