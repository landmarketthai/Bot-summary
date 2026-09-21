import { describe, expect, test } from "bun:test";
import type {
  MorningBriefPurchaseGroup,
  MorningBriefPurchaseItem,
  MorningBriefReport,
} from "./morning-brief";
import { countCodePoints } from "./line-chunking";
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
  const strong = [
    ...purchaseItems("ซื้อ", 11),
    ...purchaseItems("ปลา", 1, "ปลา / อาหารแห้ง / ของแห้ง"),
  ];
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
  test("shows every categorized purchase item and unknown reason", () => {
    const message = buildMorningBriefMessage(report());
    expect(message).toContain("🟢 ควรซื้อเพิ่ม — 12 รายการ");
    expect(message).toContain("ผัก / สมุนไพร / เครื่องประกอบอาหาร — 11 รายการ");
    expect(message).toContain("ซื้อ11");
    expect(message).toContain("ปลา / อาหารแห้ง / ของแห้ง — 1 รายการ");
    expect(message).toContain("⚠️ ยังประเมินไม่ได้ — 2 รายการ");
    expect(message).toContain("ตรวจ1 (แพค) — รายการคืน/คืนเสียของรอบยังไม่สมบูรณ์");
    expect(message).not.toContain("+อีก");
  });

  test("shows total, confirmed, pending, adjustment, and issue counts", () => {
    const message = buildMorningBriefMessage(report());
    expect(message).toContain("ยอดขายรวมที่คำนวณได้ (บางส่วน) 22,460.74 บาท");
    expect(message).toContain("ยอดยืนยันแล้ว 21,740.74 บาท");
    expect(message).toContain("ยอดรอตรวจ 720.00 บาท");
    expect(message).toContain("ปรับราคา -10.00 บาท");
    expect(message).toContain("ปัญหาราคา 2 รายการ");
    expect(message).toContain("คืน/คืนเสียไม่ครบ 1 รายการ");
    expect(message).toContain("ไม่รวมในยอด 1 รายการ");
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
      marketLabel: `ตลาดที่มีชื่อยาวมาก-${index}`,
      productName: `สินค้าที่มีชื่อยาวมาก-${index}`,
    }));
    const empty = group([]);
    const messages = buildMorningBriefMessages(report({
      purchasePlanning: { strong: empty, surplus: empty, reduce: empty, unknown: empty },
      sales: { ...base.sales, reviewItems },
      houseStock: { status: "missing" },
    }));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("ปัญหาราคา 2 รายการ");
    expect(messages[0]).not.toContain("สินค้าที่มีชื่อยาวมาก");
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
    expect(unavailable).toContain("⚠️ ยังตรวจสต๊อกบ้านไม่ได้");
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
});
