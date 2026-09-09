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
      confirmedSalesSatang: 2_174_074,
      valueAuthoritative: false,
      trustedCount: 77,
      unresolvedCount: 3,
      soldOutCount: 50,
      priceConflictCount: 2,
      priceConflictMarketCount: 2,
      reviewItems: [
        { marketLabel: "ตลาดเอ", productName: "มะละกอ", unit: "ลูก", status: "VALUE_BLOCKED", reasons: ["central_price_conflict"] },
        { marketLabel: "ตลาดบี", productName: "มังคุด", unit: "โล", status: "VALUE_BLOCKED", reasons: ["central_price_conflict"] },
        { marketLabel: "ตลาดเอ", productName: "สาลี่", unit: "ลูก", status: "QUANTITY_BLOCKED", reasons: ["product_return_absent"] },
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

  test("keeps sales labels unchanged", () => {
    const partial = buildMorningBriefMessage(report());
    expect(partial).toContain("⚠️ ยอดที่ยืนยันแล้ว 21,740.74 บาท");
    expect(partial).not.toContain("ยอดขายรวม 21,740.74 บาท");
    const authoritative = buildMorningBriefMessage(report({
      sales: { ...report().sales, valueAuthoritative: true },
    }));
    expect(authoritative).toContain("ยอดขายรวม 21,740.74 บาท");
  });

  test("shows pending-review details by reason and market", () => {
    const message = buildMorningBriefMessage(report());
    expect(message).toContain("⚠️ รายละเอียดรอตรวจ — 3 รายการ");
    expect(message).toContain("ราคากลางขัดแย้ง — 2 รายการ");
    expect(message).toContain("• ตลาดเอ: มะละกอ (ลูก)");
    expect(message).toContain("หลักฐานคืนของสินค้ายังยืนยันไม่ได้ — 1 รายการ");
    expect(message).toContain("สาลี่ (ลูก)");
    expect(message).not.toContain("central_price_conflict");
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
