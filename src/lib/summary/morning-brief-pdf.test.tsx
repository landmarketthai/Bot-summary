import React from "react";
import { describe, expect, test } from "bun:test";
import { renderToBuffer } from "@react-pdf/renderer";
import { PRODUCT_CODE_ENTRIES } from "@/lib/produce/product-code/dictionary";
import { registerFonts } from "@/lib/pdf/fonts";
import { MorningBriefA4Doc } from "@/lib/pdf/MorningBriefA4Doc";
import type { MorningBriefReport } from "@/lib/summary/morning-brief";
import { morningBriefLayoutFixture } from "../../../docs/handoffs/pr184-pdf-layout-20261020/fixtures";
import { DATE, scopeFixture } from "../../../docs/handoffs/split-morning-brief-20261021/fixtures";
import { loadMorningBriefReport } from "./morning-brief-service";
import {
  buildMorningBriefReferenceData,
  createMorningBriefPdfArtifact,
  MORNING_BRIEF_REFERENCE_SCHEMA_VERSION,
  morningBriefPdfFilename,
  morningBriefPdfLineMessage,
  morningBriefPdfPath,
  morningBriefReferencePath,
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

type PdfRenderCallback = (context: { pageNumber: number; totalPages: number }) => React.ReactNode;

function collectRenderCallbacks(node: React.ReactNode): PdfRenderCallback[] {
  if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap(collectRenderCallbacks);
  if (!React.isValidElement(node)) return [];

  const element = node as React.ReactElement<Record<string, unknown>>;
  if (typeof element.type === "function") {
    return collectRenderCallbacks((element.type as (props: Record<string, unknown>) => React.ReactNode)(element.props));
  }

  const props = element.props as { children?: React.ReactNode; render?: PdfRenderCallback };
  return [
    ...(typeof props.render === "function" ? [props.render] : []),
    ...collectRenderCallbacks(props.children),
  ];
}

describe("Morning Brief A4 PDF", () => {
  test("scoped PDFs keep the summary and stock table without weighing entries", async () => {
    for (const scope of ["fruit", "vegetable"] as const) {
      const scoped = await loadMorningBriefReport(scopeFixture({ damage: true }).client, DATE, scope);
      const text = collectText(MorningBriefA4Doc({ report: scoped, generatedAt: new Date("2026-10-20T13:00:00+07:00") }));
      expect(text).toContain("รวมคงเหลือ");
      expect(text).toContain(scope === "vegetable" ? "เฉพาะตลาดพาซิโอ้ผัก" : "ผลไม้");
      expect(text).not.toContain("รายละเอียดสินค้าและสถานะยอดขาย");
      expect(text).not.toContain("สินค้า / หน่วย");
    }
  });
  for (const count of [3, 10, 30]) {
    test(`summarizes ${count} markets and retains missing evidence and financial exceptions`, async () => {
      const base: MorningBriefReport = await Bun.file(`${import.meta.dir}/../../../docs/handoffs/pr184-uat-20261020/after-return.report.json`).json();
      const fixture = morningBriefLayoutFixture(base, count, 6, 3, 2);
      const healthy = collectText(MorningBriefA4Doc({ report: fixture, generatedAt: new Date("2026-10-20T12:15:00+07:00") })).replace(/\s+/g, " ");
      expect(healthy).toContain(`พบ ${count} ตลาด • มีเบิก ${count} ตลาด • มีชั่งคืน ${count} ตลาด • พบทั้งสองประเภท ${count} ตลาด`);
      expect(healthy).not.toContain(": เบิกมี / ชั่งคืนมี");
      fixture.produceReadiness!.markets[count - 1]!.hasReturn = false;
      fixture.sales.markets![0]!.pendingReviewSalesSatang = -21_000;
      fixture.sales.markets![0]!.unresolvedCount = 1;
      fixture.sales.markets![1]!.valueAuthoritative = false;
      fixture.sales.markets![count - 1]!.incompleteReturnIssueCount = 1;
      const text = collectText(MorningBriefA4Doc({ report: fixture, generatedAt: new Date("2026-10-20T12:15:00+07:00") })).replace(/\s+/g, " ");
      expect(text).toContain(`มีชั่งคืน ${count - 1} ตลาด • พบทั้งสองประเภท ${count - 1} ตลาด`);
      expect(text).toContain("ตลาดทดสอบ1 : เบิกมี / ชั่งคืนมี • ยอดรอตรวจ -210.00 บาท");
      expect(text).toContain(`ตลาดทดสอบ${count} : เบิกมี / ไม่พบชั่งคืน`);
      expect(text).toContain("ตลาดทดสอบ2 : เบิกมี / ชั่งคืนมี • ยอดตลาดยังไม่ยืนยัน");
      expect(text).toContain("พบข้อมูลทั้งสองประเภทไม่ได้หมายความว่ายืนยันครบ");
    });
  }

  test("fits all 64 overflow products into four pages with the last row and every unit total together", async () => {
    const base: MorningBriefReport = await Bun.file(`${import.meta.dir}/../../../docs/handoffs/pr184-uat-20261020/after-return.report.json`).json();
    const fixture = morningBriefLayoutFixture(base, 30, 48, 12, 4);
    const snapshot = JSON.stringify(fixture);
    const doc = MorningBriefA4Doc({ report: fixture, generatedAt: new Date("2026-10-20T12:15:00+07:00") });
    const text = collectText(doc).replace(/\s+/g, "");
    for (const item of fixture.purchasePlanning.strong.items!) expect(text).toContain(item.productName.replace(/\s+/g, ""));
    registerFonts();
    const pdf = await renderToBuffer(doc);
    expect((pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(4);
    expect(JSON.stringify(fixture)).toBe(snapshot);
  });

  for (const [name, expectedPages] of [["before-return", 1], ["after-return", 2]] as const) {
    test(`packs the unchanged 19 October ${name} UAT snapshot into ${expectedPages} A4 pages`, async () => {
      const fixture: MorningBriefReport = await Bun.file(`${import.meta.dir}/../../../docs/handoffs/pr184-uat-20261020/${name}.report.json`).json();
      const snapshot = JSON.stringify(fixture);
      const doc = MorningBriefA4Doc({ report: fixture, generatedAt: new Date("2026-10-20T12:15:00+07:00") });
      const text = collectText(doc).replace(/\s+/g, " ");
      expect(text).toContain("19,375.50");
      expect(text).toContain("รายละเอียดการตรวจข้อมูล");
      expect(text).toContain("สถานะข้อมูลตามตลาด");
      if (name === "before-return") {
        expect(text).toContain("ยังไม่คำนวณ 26 รายการ");
        expect(text).toContain("รอชั่งคืน 26 รายการ");
        expect(text).not.toContain("รายการ (ผลไม้)");
      } else {
        for (const amount of ["13,725.00", "5,860.50", "-210.00", "5,650.50"]) expect(text).toContain(amount);
        expect(text).toContain("รายการ (อื่นๆ)");
        for (const group of Object.values(fixture.purchasePlanning)) {
          for (const item of group.items ?? []) expect(text).toContain(item.productName);
        }
      }
      registerFonts();
      const pdf = await renderToBuffer(doc);
      expect((pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(expectedPages);
      expect(JSON.stringify(fixture)).toBe(snapshot);
    });
  }

  test("preserves financial category labels and canonical stock identity when packing pages", async () => {
    const empty = { count: 0, productNames: [], items: [] };
    const summary = { withdrawalValueSatang: 200, salesValueSatang: 100, goodReturnValueSatang: 100,
      houseStockValueSatang: 300, readyValueSatang: 400, markets: [] };
    const mixed: MorningBriefReport = {
      ...report, produceFinancial: { vegetable: summary, other: { ...summary, salesValueSatang: 900 } },
      purchasePlanning: { strong: empty, surplus: empty, reduce: empty, unknown: empty },
      houseStock: { status: "available", groupCount: 2, totalValueSatang: 600, items: [
        { productName: "ใบกุยช่าย", category: "ไม่ระบุหมวด", unit: "แพค", quantity: 3, unitPriceSatang: 100, valueSatang: 300 },
        { productName: "หมอนทอง", category: "ผลไม้", unit: "โล", quantity: 3, unitPriceSatang: 100, valueSatang: 300 },
      ] },
    };
    const tree = MorningBriefA4Doc({ report: mixed, generatedAt: new Date("2026-10-07T08:00:00+07:00") });
    const text = collectText(tree);
    expect(text).toContain("ยอดขายยืนยันแล้ว");
    expect(text).toContain("มูลค่าสินค้ารอจัดหมวด");
    expect(text).not.toContain("สรุปอื่นๆคงเหลือเพื่อสั่งซื้อ");
    expect(text).toContain("หมวดผลไม้ -");
    expect(text).toContain("หมวดผัก -");
    expect(text).not.toContain("หมวดอื่นๆ -");
    expect(text).not.toContain("ไม่ระบุหมวด");
    expect(text.indexOf("หมอนทอง")).toBeGreaterThan(text.indexOf("หมวดผลไม้ -"));
    expect(text.indexOf("หมอนทอง")).toBeLessThan(text.indexOf("หมวดผัก -"));
    expect(text.indexOf("ใบกุยช่าย")).toBeGreaterThan(text.indexOf("หมวดผัก -"));
    registerFonts();
    const buffer = await renderToBuffer(tree);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  test("uses deterministic date-based PDF and reference paths", () => {
    expect(morningBriefPdfFilename("2026-09-19")).toBe("morning-brief-2026-09-19.pdf");
    expect(morningBriefPdfPath("2026-09-19")).toBe("2026-09-19/morning-brief-2026-09-19.pdf");
    expect(morningBriefReferencePath("2026-09-19")).toBe("2026-09-19/morning-brief-2026-09-19.ref.json");
  });

  test("builds stable daily reference data from the same Morning Brief report", () => {
    const generatedAt = new Date("2026-09-20T08:00:00+07:00");
    const ref = buildMorningBriefReferenceData(report, generatedAt, {
      bucket: "morning-brief-pdfs",
      path: morningBriefPdfPath(report.businessDate),
      filename: morningBriefPdfFilename(report.businessDate),
    });

    expect(ref.schemaVersion).toBe(MORNING_BRIEF_REFERENCE_SCHEMA_VERSION);
    expect(ref.businessDate).toBe("2026-09-19");
    expect(ref.generatedAt).toBe(generatedAt.toISOString());
    expect(ref.pdf.path).toBe("2026-09-19/morning-brief-2026-09-19.pdf");
    expect(ref.report).toBe(report);
  });

  test("LINE download message contains the signed URL and expiry hint", () => {
    const text = morningBriefPdfLineMessage("https://example.test/signed.pdf");
    expect(text).toContain("PDF สำหรับพิมพ์ A4");
    expect(text).toContain("https://example.test/signed.pdf");
    expect(text).toContain("7 วัน");
  });

  test("shows the missing House Stock as pending without fabricating Stock plus good returns", async () => {
    const missingStock: MorningBriefReport = {
      ...report,
      houseStock: { status: "missing" },
      fruitFinancial: { ...report.fruitFinancial!, houseStockValueSatang: null, readyValueSatang: null },
    };
    const doc = MorningBriefA4Doc({ report: missingStock, generatedAt: new Date("2026-10-13T08:00:00+07:00") });
    const text = collectText(doc);
    expect(text).toContain("รอข้อมูล");
    expect(text).toContain("รอยอดบ้าน");
    expect(text).toContain("ยังไม่มียอดบ้าน");
    expect(text).not.toContain("ยังไม่มี Stock บ้านที่ปิดยืนยัน");
    expect(text).toContain("60,755.83");
    expect(text).not.toContain("ยอดพร้อมขายยังสรุปไม่ได้");
    registerFonts();
    const buffer = await renderToBuffer(doc);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  test("still shows financial Stock and ready totals when an authoritative snapshot exists", () => {
    const text = collectText(MorningBriefA4Doc({ report, generatedAt: new Date("2026-09-20T08:00:00+07:00") }));
    expect(text).toContain("10,033.20");
    expect(text).toContain("70,789.03");
    expect(text).not.toContain("ยอดพร้อมขายยังสรุปไม่ได้");
  });
  test("restores whole-day sales on page one before splitting the 13 October categories", async () => {
    const fruit = {
      withdrawalValueSatang: 4_378_553,
      salesValueSatang: 1_125_352, pendingReviewSalesSatang: 50_000,
      goodReturnValueSatang: 3_235_524,
      houseStockValueSatang: null, readyValueSatang: null, markets: [],
    };
    const vegetable = {
      withdrawalValueSatang: 37_000,
      salesValueSatang: 11_000,
      goodReturnValueSatang: 26_000,
      houseStockValueSatang: null, readyValueSatang: null, markets: [],
    };
    const other = {
      withdrawalValueSatang: 875_200,
      salesValueSatang: 263_800,
      goodReturnValueSatang: 611_400,
      houseStockValueSatang: null, readyValueSatang: null, markets: [],
    };
    const daily: MorningBriefReport = {
      ...report,
      businessDate: "2026-10-13",
      sales: {
        ...report.sales,
        totalSalesSatang: 1_450_152,
        confirmedSalesSatang: 1_400_152,
        pendingReviewSalesSatang: 50_000,
        valueAuthoritative: false,
      adjustmentSatang: 0,
      },
      produceFinancial: { fruit, vegetable, other },
      fruitFinancial: fruit,
      houseStock: { status: "missing" },
    };
    const doc = MorningBriefA4Doc({ report: daily, generatedAt: new Date("2026-10-14T08:05:00+07:00") });
    const text = collectText(doc);
    const normalized = text.replace(/\s+/g, " ").trim();
    expect(text).toContain("ยอดขายยืนยันแล้ว");
    expect(text).toContain("14,001.52");
    expect(text.indexOf("14,001.52")).toBeLessThan(text.indexOf("หมวดผลไม้ -"));
    expect(normalized).toContain("ยืนยันแล้ว 14,001.52 บาท");
    expect(normalized).toContain("รอตรวจ 500.00 บาท");
    expect(normalized).toContain("ยอดขายยืนยันแล้ว 11,253.52 บาท");
    expect(normalized).toContain("ยอดขายยืนยันแล้ว 110.00 บาท");
    expect(normalized).toContain("มูลค่าสินค้ารอจัดหมวด 2,638.00 บาท");
    expect(text).not.toContain("สรุปอื่นๆคงเหลือเพื่อสั่งซื้อ");
    expect(text).not.toContain("ต่างจากยอดขายยืนยันแล้วในระบบ");
    registerFonts();
    const buffer = await renderToBuffer(doc);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  test("places fruit and vegetable money fields directly above their own stock table, never on the overview cover", async () => {
    const fruit = {
      withdrawalValueSatang: 4_832_434, salesValueSatang: 1_548_075, goodReturnValueSatang: 3_284_382,
      houseStockValueSatang: null, readyValueSatang: null,
      markets: [{ marketLabel: "พาซิโอ้ผลไม้", withdrawalValueSatang: 4_832_434,
        salesValueSatang: 1_548_075, goodReturnValueSatang: 3_284_382 }],
    };
    const vegetable = {
      withdrawalValueSatang: 50_000, salesValueSatang: 50_000, goodReturnValueSatang: 0,
      houseStockValueSatang: null, readyValueSatang: null,
      markets: [{ marketLabel: "พาซิโอ้ผลไม้", withdrawalValueSatang: 50_000,
        salesValueSatang: 50_000, goodReturnValueSatang: 0 }],
    };
    const data: MorningBriefReport = {
      ...report, businessDate: "2026-10-11",
      sales: { ...report.sales, totalSalesSatang: 1_598_075, confirmedSalesSatang: 1_598_075,
        pendingReviewSalesSatang: 0, excludedFromSalesCount: 1 },
      produceFinancial: { fruit, vegetable },
      fruitFinancial: fruit,
      houseStock: { status: "missing" },
      purchasePlanning: {
        ...report.purchasePlanning,
        strong: { count: 2, productNames: ["มังคุด", "มะเขือราชินี"], items: [
          { productName: "มังคุด", originalProductName: null, category: "ผลไม้", unit: "โล",
            uncertaintyReasons: [], marketStockQuantity: 3, houseStockQuantity: null, totalRemainingQuantity: null },
          { productName: "มะเขือราชินี", originalProductName: null, category: "ผัก", unit: "โล",
            uncertaintyReasons: [], marketStockQuantity: 2.2, houseStockQuantity: null, totalRemainingQuantity: null },
        ] },
        surplus: { count: 0, productNames: [], items: [] },
      },
    };
    const doc = MorningBriefA4Doc({ report: data, generatedAt: new Date("2026-10-12T08:00:00+07:00") });
    const fragment = (doc as React.ReactElement<{ children: React.ReactNode }>).props.children;
    const pages = React.Children.toArray((fragment as React.ReactElement<{ children: React.ReactNode }>).props.children);
    expect(pages).toHaveLength(2);
    const cover = collectText(pages[0]).replace(/\s+/g, " ");
    const detail = collectText(pages[1]).replace(/\s+/g, " ");
    for (const amount of ["15,980.75", "48,824.34", "32,843.82"]) expect(cover).toContain(amount);
    for (const phrase of ["หมวดผลไม้", "หมวดผัก"]) {
      expect(cover).not.toContain(phrase);
      expect(detail).toContain(phrase);
    }
    const fruitHeader = detail.indexOf("หมวดผลไม้ -");
    const fruitKpis = detail.indexOf("ยอดขายยืนยันแล้ว", fruitHeader);
    const fruitTable = detail.indexOf("รายการ (ผลไม้)");
    const vegHeader = detail.indexOf("หมวดผัก -");
    const vegKpis = detail.indexOf("ยอดขายยืนยันแล้ว", vegHeader);
    const vegTable = detail.indexOf("รายการ (ผัก)");
    expect(fruitHeader).toBeGreaterThanOrEqual(0);
    expect(fruitKpis).toBeGreaterThan(fruitHeader);
    expect(fruitTable).toBeGreaterThan(fruitKpis);
    expect(vegHeader).toBeGreaterThan(fruitTable);
    expect(vegKpis).toBeGreaterThan(vegHeader);
    expect(vegTable).toBeGreaterThan(vegKpis);
    for (const phrase of ["48,324.34", "32,843.82", "สต็อกที่บ้าน", "รอข้อมูล",
      "รอยอดบ้าน", "คงเหลือพร้อมขาย", "500.00", "0.00"]) expect(detail).toContain(phrase);
    expect(cover).toContain("ยืนยันแล้ว");
    expect(cover).toContain("รอตรวจ");
    expect(cover).toContain("รายละเอียดการตรวจข้อมูล");
    expect(detail).not.toContain("คำอธิบายตัวเลข");
    registerFonts();
    const buffer = await renderToBuffer(doc);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  test("balances all five KPI cards with concise titles and no overflowing old labels", () => {
    const text = collectText(MorningBriefA4Doc({ report, generatedAt: new Date("2026-10-16T08:00:00+07:00") }));
    for (const title of ["ยอดขายยืนยันแล้ว", "ยอดเบิกไปขาย", "ยอดชั่งคืนดี", "สต็อกที่บ้าน", "คงเหลือพร้อมขาย"]) {
      expect(text).toContain(title);
    }
    expect(text).not.toContain("รวมทุกสินค้าที่เบิกออกไปขายเมื่อวาน");
    expect(text).not.toContain("ชั่งคืนดีจากตลาด + Stock บ้าน");
  });

  test("shows an informational A4 page, not a fabricated zero sale, when no produce arrived", async () => {
    const empty: MorningBriefReport = {
      ...report,
      sales: { ...report.sales, totalSalesSatang: 0, confirmedSalesSatang: 0,
        pendingReviewSalesSatang: 0, valueAuthoritative: true },
      produceReadiness: { transactionCount: 0, markets: [] },
      produceFinancial: {},
      fruitFinancial: undefined,
      houseStock: { status: "missing" },
      whiteSheetStatus: "missing",
    };
    const doc = MorningBriefA4Doc({ report: empty, generatedAt: new Date("2026-10-16T08:00:00+07:00") });
    const text = collectText(doc);
    expect(text).toContain("ยังไม่มีข้อมูลสำหรับสรุปยอดขาย");
    expect(text).toContain("รายการเบิกสินค้า");
    expect(text).toContain("ยังไม่มีข้อมูล");
    expect(text).toContain("สถานะข้อมูลแต่ละส่วน");
    expect(text).toContain("การอ่านรายงานฉบับนี้");
    expect(text).toContain("ใบขาว");
    expect(text).toContain("ยังไม่มีใบขาวที่บันทึกยืนยันได้");
    expect(text).not.toContain("0.00 บาท");
    registerFonts();
    const bytes = await renderToBuffer(doc);
    expect((bytes.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(1);
  });

  test("separates confirmed, pending and unavailable values on the cover and detail pages", () => {
    const withPending: MorningBriefReport = {
      ...report,
      sales: { ...report.sales, excludedFromSalesCount: 2, valueAuthoritative: false },
      produceFinancial: { fruit: report.fruitFinancial! },
    };
    const doc = MorningBriefA4Doc({ report: withPending, generatedAt: new Date("2026-10-14T08:00:00+07:00") });
    const fragment = (doc as React.ReactElement<{ children: React.ReactNode }>).props.children;
    const pages = React.Children.toArray((fragment as React.ReactElement<{ children: React.ReactNode }>).props.children);
    expect(pages).toHaveLength(2);
    const cover = collectText(pages[0]);
    const details = collectText(pages[1]);
    expect(cover).toContain("ยอดขายยืนยันแล้ว");
    expect(cover).toContain("1,234.56");
    for (const text of ["ปรับราคา", "รายละเอียดการตรวจข้อมูล"]) {
      expect(cover).toContain(text);
    }
    expect(details).toContain("ยอดขายยืนยันแล้ว");
    expect(cover).toContain("ยอดรอตรวจ");
    expect(cover).toContain("ยอดปรับราคา");
    expect(cover.replace(/\s+/g, " ")).toContain("มี 2 รายการที่คำนวณยอดขายไม่ได้");
  });

  test("warns when category sums disagree with the authoritative daily sales instead of silently replacing it", () => {
    const daily: MorningBriefReport = {
      ...report,
      produceFinancial: {
        fruit: { ...report.fruitFinancial!, salesValueSatang: 1_000 },
        vegetable: { ...report.fruitFinancial!, salesValueSatang: 2_000 },
        other: { ...report.fruitFinancial!, salesValueSatang: 3_000 },
      },
      sales: { ...report.sales, totalSalesSatang: 7_000, confirmedSalesSatang: 7_000, pendingReviewSalesSatang: 0 },
    };
    const text = collectText(MorningBriefA4Doc({ report: daily, generatedAt: new Date("2026-10-14T08:05:00+07:00") }));
    expect(text).toContain("ยอดขายยืนยันแล้ว");
    expect(text.replace(/\s+/g, " ")).toContain("ยอดแยกหมวดรวม 60.00 บาท ต่างจากยอดขายยืนยันแล้วในระบบ");
    expect(text.replace(/\s+/g, " ")).toContain("70.00 บาท");
  });

  test("retains the daily sales headline when no financial section is available", () => {
    const daily: MorningBriefReport = {
      ...report,
      produceFinancial: {},
      fruitFinancial: undefined,
      sales: { ...report.sales, totalSalesSatang: 12_345, confirmedSalesSatang: 12_345, pendingReviewSalesSatang: 0 },
    };
    const text = collectText(MorningBriefA4Doc({ report: daily, generatedAt: new Date("2026-10-14T08:05:00+07:00") }));
    expect(text).toContain("ยอดขายยืนยันแล้ว");
    expect(text.replace(/\s+/g, " ")).toContain("123.45 บาท");
    expect(text).not.toContain("ยังไม่มีข้อมูลสินค้าในระบบ");
  });

  test("shows yesterday sales total in the top KPI row", () => {
    const text = collectText(MorningBriefA4Doc({ report, generatedAt: new Date("2026-09-19T08:00:00+07:00") }));
    expect(text).toContain("ยอดขายยืนยันแล้ว");
    expect(text).toContain("22,511.58");
  });

  test("keeps five operational KPIs and drops the explanatory prose", () => {
    const text = collectText(MorningBriefA4Doc({ report, generatedAt: new Date("2026-09-19T08:00:00+07:00") }));
    expect(text).toContain("คงเหลือพร้อมขาย");
    expect(text).toContain("ชั่งคืนดี + สต็อกบ้าน");
    expect(text).not.toContain("คงเหลือพร้อมขาย (ชั่งคืนดี + บ้าน)");
    expect(text).toContain("สต็อกที่บ้าน");
    expect(text).not.toContain("คำอธิบายตัวเลข");
    expect(text).not.toContain("มูลค่าสินค้าที่นำออกตลาดก่อนเริ่มขาย");
  });

  test("uses the requested stock columns and remaps บ้านเจ๊, market, then total", () => {
    const layoutReport: MorningBriefReport = { ...report, businessDate: "2026-09-22" };
    const text = collectText(MorningBriefA4Doc({ report: layoutReport, generatedAt: new Date("2026-09-23T08:00:00+07:00") }));
    const normalized = text.replace(/\s+/g, " ").trim();
    expect(normalized).toContain("หมวดผลไม้ - 22 กันยายน 2569");

    expect(normalized).toContain("รายการ (ผลไม้) บ้านเจ๊ ในตลาด รวมคงเหลือ");

    const apple = text.indexOf("แอปเปิ้ล");
    const house = text.indexOf("40", apple);
    const market = text.indexOf("372", house);
    const total = text.indexOf("412", market);
    expect(apple).toBeGreaterThanOrEqual(0);
    expect(house).toBeGreaterThan(apple);
    expect(market).toBeGreaterThan(house);
    expect(total).toBeGreaterThan(market);
  });

  test("renders only non-empty categories in order and keeps house-only products visible", () => {
    const categoryReport: MorningBriefReport = {
      ...report,
      houseStock: {
        status: "available",
        groupCount: 3,
        totalValueSatang: 1_000,
        items: [
          { productName: "เห็ดนางฟ้า", category: "เห็ด", unit: "กก.", quantity: 3, unitPriceSatang: 100, valueSatang: 300 },
          { productName: "ปลาทู", category: "ปลา / อาหารแห้ง / ของแห้ง", unit: "ตัว", quantity: 5, unitPriceSatang: 100, valueSatang: 500 },
          { productName: "สินค้าใหม่", category: "พิเศษ", unit: "ถุง", quantity: 2, unitPriceSatang: 100, valueSatang: 200 },
        ],
      },
    };
    const text = collectText(MorningBriefA4Doc({ report: categoryReport, generatedAt: new Date("2026-09-20T08:00:00+07:00") }));
    const headings = [
      "หมวดผลไม้ - 19 กันยายน 2569",
      "หมวดผัก - 19 กันยายน 2569",
      "หมวดอื่นๆ - 19 กันยายน 2569",
    ];
    const positions = headings.map((heading) => text.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(text).not.toContain("หมวดทุเรียน");
    expect(text).not.toContain("ยังไม่มีข้อมูลสินค้า");
    expect(text.indexOf("เห็ดนางฟ้า")).toBeGreaterThan(text.indexOf("หมวดผัก"));
    expect(text.indexOf("ปลาทู")).toBeGreaterThan(text.indexOf("หมวดอื่นๆ"));
    expect(text.indexOf("สินค้าใหม่")).toBeGreaterThan(text.indexOf("หมวดอื่นๆ"));
  });

  test("skips a category with no rows", () => {
    const text = collectText(MorningBriefA4Doc({ report, generatedAt: new Date("2026-09-20T08:00:00+07:00") }));
    expect(text).toContain("หมวดผลไม้ - 19 กันยายน 2569");
    expect(text).not.toContain("หมวดทุเรียน");
    expect(text).not.toContain("ยังไม่มีข้อมูลสินค้า");
  });

  test("skips a category whose rows are all zero", () => {
    const zeroOnlyReport: MorningBriefReport = {
      ...report,
      houseStock: {
        status: "available",
        groupCount: 1,
        totalValueSatang: 0,
        items: [
          { productName: "ขนมจีน", category: "ของแห้ง", unit: "ถุง", quantity: 0, unitPriceSatang: 100, valueSatang: 0 },
        ],
      },
    };
    const text = collectText(MorningBriefA4Doc({ report: zeroOnlyReport, generatedAt: new Date("2026-09-20T08:00:00+07:00") }));
    expect(text).not.toContain("หมวดอื่นๆ");
    expect(text).not.toContain("ขนมจีน");
    expect(text).not.toContain("ยังไม่มีข้อมูลสินค้า");
  });

  test("keeps a category when at least one row has a positive quantity", () => {
    const mixedReport: MorningBriefReport = {
      ...report,
      houseStock: {
        status: "available",
        groupCount: 2,
        totalValueSatang: 200,
        items: [
          { productName: "ขนมจีน", category: "ของแห้ง", unit: "ถุง", quantity: 0, unitPriceSatang: 100, valueSatang: 0 },
          { productName: "ปลาทู", category: "ของแห้ง", unit: "ตัว", quantity: 2, unitPriceSatang: 100, valueSatang: 200 },
        ],
      },
    };
    const text = collectText(MorningBriefA4Doc({ report: mixedReport, generatedAt: new Date("2026-09-20T08:00:00+07:00") }));
    expect(text).toContain("หมวดอื่นๆ - 19 กันยายน 2569");
    expect(text).toContain("ขนมจีน");
    expect(text).toContain("ปลาทู");
  });

  test("recalculates total pages and footer page numbers after skipped categories", async () => {
    const zeroOnlyReport: MorningBriefReport = {
      ...report,
      houseStock: {
        status: "available",
        groupCount: 1,
        totalValueSatang: 0,
        items: [
          { productName: "ขนมจีน", category: "ของแห้ง", unit: "ถุง", quantity: 0, unitPriceSatang: 100, valueSatang: 0 },
        ],
      },
    };
    const doc = MorningBriefA4Doc({ report: zeroOnlyReport, generatedAt: new Date("2026-09-20T08:00:00+07:00") });

    registerFonts();
    const buffer = await renderToBuffer(doc);
    const totalPages = (buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;
    // The clean executive summary has its own page; stock follows on page two.
    expect(totalPages).toBe(2);

    // Both document sections have page-number footers with the same total.
    const footerRenders = collectRenderCallbacks(doc);
    expect(footerRenders).toHaveLength(2);
    expect(footerRenders[0]?.({ pageNumber: 1, totalPages })).toBe("หน้า 1/2");
    expect(footerRenders[1]?.({ pageNumber: 2, totalPages })).toBe("หน้า 2/2");
  });

  test("flows a long category as one table with every row exactly once", async () => {
    const items = Array.from({ length: 31 }, (_, index) => ({
      productName: PRODUCT_CODE_ENTRIES.filter((entry) => entry.enabled && entry.category === "ผลไม้")[index]!.canonicalName,
      originalProductName: null,
      category: "ผลไม้",
      unit: "กก.",
      uncertaintyReasons: [],
      marketStockQuantity: index + 1,
      houseStockQuantity: 0,
      totalRemainingQuantity: index + 1,
    }));
    const pagedReport: MorningBriefReport = {
      ...report,
      purchasePlanning: {
        strong: { count: items.length, productNames: items.map((item) => item.productName), items },
        surplus: { count: 0, productNames: [], items: [] },
        reduce: { count: 0, productNames: [], items: [] },
        unknown: { count: 0, productNames: [], items: [] },
      },
      houseStock: { status: "missing" },
    };
    const text = collectText(MorningBriefA4Doc({ report: pagedReport, generatedAt: new Date("2026-09-20T08:00:00+07:00") }));
    // One heading per category; the fixed column header repeats on each
    // physical page instead of artificial 15-row "1/3" sections.
    expect((text.match(/หมวดผลไม้ - 19 กันยายน 2569/g) ?? []).length).toBe(1);
    expect(text).not.toContain("หมวดผลไม้ 1/");
    const tokens = text.split(/\s+/);
    for (const item of items) {
      expect(tokens.filter((token) => token === item.productName)).toHaveLength(1);
    }
    expect((text.match(/รวม \(กก\.\)/g) ?? []).length).toBe(1);
    expect(text.replace(/\s+/g, " ")).toContain("รวม (กก.) 0 496 496");

    registerFonts();
    const buffer = await renderToBuffer(
      <MorningBriefA4Doc report={pagedReport} generatedAt={new Date("2026-09-20T08:00:00+07:00")} />,
    );
    // Executive cover comes first; detail tables still flow without a new page per category.
    expect((buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  test("packs the 11 October shape without empty vegetable-finance pages or lost stock rows", async () => {
    const zeroFinancial = {
      withdrawalValueSatang: 0, salesValueSatang: 0, goodReturnValueSatang: 0,
      houseStockValueSatang: null, readyValueSatang: null,
      markets: [{ marketLabel: "พาซิโอ้ผลไม้", withdrawalValueSatang: 0, salesValueSatang: 0, goodReturnValueSatang: 0 }],
    };
    const marketLabels = ["พาซิโอ้ผลไม้", "ราชพฤกษ์", "โรงถ่าน", "วัดตะกล่ำ", "วัดทุ่งลานนา"];
    const fruitItems = PRODUCT_CODE_ENTRIES
      .filter((entry) => entry.enabled && entry.category === "ผลไม้")
      .slice(0, 25)
      .map((entry, index) => ({
        productName: entry.canonicalName, originalProductName: null,
        category: "ผลไม้", unit: "โล", uncertaintyReasons: [],
        marketStockQuantity: index + 1, houseStockQuantity: null, totalRemainingQuantity: null,
      }));
    const layoutReport: MorningBriefReport = {
      ...report,
      businessDate: "2026-10-11",
      produceFinancial: {
        fruit: {
          ...report.fruitFinancial!,
          markets: marketLabels.map((marketLabel, index) => ({
            marketLabel, withdrawalValueSatang: 100_000 + index * 1000,
            salesValueSatang: 25_000 + index * 1000, goodReturnValueSatang: 75_000,
          })),
        },
        vegetable: zeroFinancial,
        other: {
          withdrawalValueSatang: 374_000, salesValueSatang: 98_400, goodReturnValueSatang: 275_600,
          houseStockValueSatang: null, readyValueSatang: null,
          markets: marketLabels.map((marketLabel) => ({
            marketLabel, withdrawalValueSatang: 74_800,
            salesValueSatang: 19_680, goodReturnValueSatang: 55_120,
          })),
        },
      },
      purchasePlanning: {
        strong: { count: fruitItems.length, productNames: fruitItems.map((item) => item.productName), items: fruitItems },
        surplus: { count: 0, productNames: [], items: [] },
        reduce: { count: 0, productNames: [], items: [] },
        unknown: { count: 0, productNames: [] },
      },
      houseStock: {
        status: "available", groupCount: 2, totalValueSatang: 0,
        items: [
          { productName: "มะเขือราชินี", category: "ผัก", unit: "โล", quantity: 2.2, unitPriceSatang: 0, valueSatang: 0 },
          { productName: "ปลาทู", category: "ของแห้ง", unit: "ตัว", quantity: 5, unitPriceSatang: 0, valueSatang: 0 },
        ],
      },
    };
    const doc = MorningBriefA4Doc({ report: layoutReport, generatedAt: new Date("2026-10-12T08:05:00+07:00") });
    const text = collectText(doc);
    expect(text).toContain("ยอดขายยืนยันแล้ว");
    expect(text).toContain("มูลค่าสินค้ารอจัดหมวด");
    expect(text).not.toContain("สรุปอื่นๆคงเหลือเพื่อสั่งซื้อ");
    expect(text).toContain("ยอดขายยืนยันแล้ว");
    expect(text).toContain("หมวดผัก");
    expect(text).toContain("มะเขือราชินี");
    expect(text).toContain("2.2");
    expect(text).toContain("หมวดอื่นๆ");
    expect(text).toContain("ปลาทู");
    expect(text).toContain("พาซิโอ้ผลไม้");
    for (const item of fruitItems) expect(text).toContain(item.productName);
    registerFonts();
    const buffer = await renderToBuffer(doc);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
    const pages = (buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;
    // One executive cover plus flow-paginated financial and stock details.
    // No extra standalone page is forced for the small vegetable stock.
    expect(pages).toBeLessThanOrEqual(4);
    expect(pages).toBeGreaterThanOrEqual(2);
  });

  test("keeps three active financial categories together when space permits", async () => {
    const small = { withdrawalValueSatang: 1000, salesValueSatang: 300,
      goodReturnValueSatang: 700, houseStockValueSatang: null, readyValueSatang: null,
      markets: [{ marketLabel: "ตลาดทดสอบ", withdrawalValueSatang: 1000, salesValueSatang: 300, goodReturnValueSatang: 700 }] };
    const allActive: MorningBriefReport = {
      ...report,
      produceFinancial: { fruit: small, vegetable: small, other: small },
      purchasePlanning: { strong: { count: 0, productNames: [], items: [] }, surplus: { count: 0, productNames: [], items: [] },
        reduce: { count: 0, productNames: [], items: [] }, unknown: { count: 0, productNames: [] } },
      houseStock: { status: "missing" },
    };
    const doc = MorningBriefA4Doc({ report: allActive, generatedAt: new Date("2026-09-20T08:00:00+07:00") });
    const content = collectText(doc);
    for (const label of ["ผลไม้", "ผัก"]) {
      expect(content).toContain(`หมวด${label}`);
      expect(content).not.toContain(`รายการ (${label})`);
    }
    expect(content).not.toContain("สรุปอื่นๆคงเหลือเพื่อสั่งซื้อ");
    expect(content).toContain("มูลค่าสินค้ารอจัดหมวด");
    registerFonts();
    const buffer = await renderToBuffer(doc);
    expect((buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  test("paginates unusually long market tables and stock units without dropping rows", async () => {
    const markets = Array.from({ length: 22 }, (_, i) => ({
      marketLabel: `ตลาดทดสอบ${i + 1}`, withdrawalValueSatang: 2000,
      salesValueSatang: 600, goodReturnValueSatang: 1400,
    }));
    const items = PRODUCT_CODE_ENTRIES
      .filter((entry) => entry.enabled && entry.category === "ผลไม้")
      .slice(0, 20)
      .map((entry, i) => ({
        productName: entry.canonicalName, originalProductName: null,
        category: "ผลไม้", unit: `หน่วย${i}`, uncertaintyReasons: [],
        marketStockQuantity: i + 1, houseStockQuantity: 0, totalRemainingQuantity: i + 1,
      }));
    const busy: MorningBriefReport = {
      ...report,
      fruitFinancial: {
        withdrawalValueSatang: 44_000, salesValueSatang: 13_200,
        goodReturnValueSatang: 30_800, houseStockValueSatang: null,
        readyValueSatang: null, markets,
      },
      purchasePlanning: {
        strong: { count: items.length, productNames: items.map((item) => item.productName), items },
        surplus: { count: 0, productNames: [], items: [] },
        reduce: { count: 0, productNames: [], items: [] },
        unknown: { count: 0, productNames: [] },
      },
      houseStock: { status: "missing" },
    };
    const doc = MorningBriefA4Doc({ report: busy, generatedAt: new Date("2026-09-20T08:00:00+07:00") });
    const text = collectText(doc);
    for (const market of markets) expect(text).toContain(market.marketLabel);
    for (const item of items) expect(text).toContain(item.productName);
    registerFonts();
    const pdf = await renderToBuffer(doc);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect((pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBeGreaterThan(2);
  });

  test("falls back to one informational page only when all categories lack real data", async () => {
    const empty: MorningBriefReport = {
      ...report,
      fruitFinancial: undefined,
      produceFinancial: undefined,
      sales: {
        ...report.sales,
        totalSalesSatang: 0, confirmedSalesSatang: 0,
        pendingReviewSalesSatang: 0, adjustmentSatang: 0,
      },
      purchasePlanning: {
        strong: { count: 0, productNames: [], items: [] },
        surplus: { count: 0, productNames: [], items: [] },
        reduce: { count: 0, productNames: [], items: [] },
        unknown: { count: 0, productNames: [] },
      },
      houseStock: { status: "missing" },
    };
    const doc = MorningBriefA4Doc({ report: empty, generatedAt: new Date("2026-09-20T08:00:00+07:00") });
    expect(collectText(doc)).toContain("ยังไม่มีข้อมูลสินค้าในระบบ");
    registerFonts();
    const pdf = await renderToBuffer(doc);
    expect((pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(1);
  });

  test("persists one upserted reference sidecar for the business date", async () => {
    const uploads: Array<{
      path: string;
      body: Uint8Array;
      options: { contentType?: string; cacheControl?: string; upsert?: boolean };
    }> = [];
    const bucket = {
      upload: async (
        path: string,
        body: Uint8Array,
        options: { contentType?: string; cacheControl?: string; upsert?: boolean },
      ) => {
        uploads.push({ path, body, options });
        return { error: null };
      },
      createSignedUrl: async () => ({
        data: { signedUrl: "https://example.test/morning-brief.pdf?token=signed" },
        error: null,
      }),
    };
    const fakeSupabase = {
      storage: { from: () => bucket },
    } as unknown as Parameters<typeof createMorningBriefPdfArtifact>[0];
    const generatedAt = new Date("2026-09-20T08:00:00+07:00");

    const artifact = await createMorningBriefPdfArtifact(fakeSupabase, report, generatedAt);

    expect(uploads.map((upload) => upload.path)).toEqual([
      "2026-09-19/morning-brief-2026-09-19.pdf",
      "2026-09-19/morning-brief-2026-09-19.ref.json",
    ]);
    expect(uploads[1]?.options.upsert).toBe(true);
    expect(uploads[1]?.options.contentType).toBe("application/json");
    const saved = JSON.parse(new TextDecoder().decode(uploads[1]?.body));
    expect(saved.businessDate).toBe("2026-09-19");
    expect(saved.generatedAt).toBe(generatedAt.toISOString());
    expect(saved.report.fruitFinancial.readyValueSatang).toBe(7_078_903);
    expect(artifact.referencePath).toBe("2026-09-19/morning-brief-2026-09-19.ref.json");
  });

  test("keeps the clean daily summary separate from the short stock table", async () => {
    registerFonts();
    const buffer = await renderToBuffer(
      <MorningBriefA4Doc report={report} generatedAt={new Date("2026-09-19T08:00:00+07:00")} />,
    );
    expect(buffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(5_000);
    expect((buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(2);
  });

  test("sums house Stock groups split by unit price instead of keeping only the first", () => {
    const empty = { count: 0, productNames: [], items: [] };
    const split: MorningBriefReport = {
      ...report,
      purchasePlanning: { strong: empty, surplus: empty, reduce: empty, unknown: empty },
      houseStock: { status: "available", groupCount: 2, totalValueSatang: 0, items: [
        { productName: "มังคุด", category: "ผลไม้", unit: "กก.", quantity: 2.25, unitPriceSatang: 8_000, valueSatang: 18_000 },
        { productName: "มังคุด", category: "ผลไม้", unit: "โล", quantity: 3.5, unitPriceSatang: 9_000, valueSatang: 31_500 },
      ] },
    };
    const normalized = collectText(MorningBriefA4Doc({ report: split, generatedAt: new Date("2026-09-20T08:00:00+07:00") }))
      .replace(/\s+/g, " ");
    expect(normalized).toContain("มังคุด (กก.) 5.75 5.75");
    expect(normalized).not.toContain("มังคุด 2.25");
    expect((normalized.match(/มังคุด/g) ?? []).length).toBe(1);
  });

  test("labels every stock product row with its own unit, including unknown units", () => {
    const empty = { count: 0, productNames: [], items: [] };
    const labeled: MorningBriefReport = {
      ...report,
      purchasePlanning: { strong: empty, surplus: empty, reduce: empty, unknown: empty },
      houseStock: { status: "available", groupCount: 3, totalValueSatang: 0, items: [
        { productName: "แตงไทย", category: "ผลไม้", unit: "ลูก", quantity: 3, unitPriceSatang: 0, valueSatang: 0 },
        { productName: "มะเขือราชินี", category: "ผัก", unit: "โล", quantity: 2.2, unitPriceSatang: 0, valueSatang: 0 },
        { productName: "สินค้าทดสอบไม่ทราบหน่วย", category: "อื่นๆ", unit: "", quantity: 1, unitPriceSatang: 0, valueSatang: 0 },
      ] },
    };
    const normalized = collectText(MorningBriefA4Doc({
      report: labeled, generatedAt: new Date("2026-09-20T08:00:00+07:00"),
    })).replace(/\s+/g, " ");
    expect(normalized).toContain("แตงไทย (ลูก) 3 3");
    expect(normalized).toContain("มะเขือราชินี (กก.) 2.2 2.2");
    expect(normalized).toContain("สินค้าทดสอบไม่ทราบหน่วย (ไม่ระบุหน่วย) 1 1");
  });

  test("totals โล and กก. rows in one รวม (กก.) row, never two partial rows", () => {
    const planned: MorningBriefReport = {
      ...report,
      houseStock: { status: "available", groupCount: 1, totalValueSatang: 0, items: [
        { productName: "มังคุด", category: "ผลไม้", unit: "กก.", quantity: 4, unitPriceSatang: 100, valueSatang: 400 },
      ] },
    };
    const normalized = collectText(MorningBriefA4Doc({ report: planned, generatedAt: new Date("2026-09-20T08:00:00+07:00") }))
      .replace(/\s+/g, " ");
    // พุทราจีน 0+10.1, แก้วมังกร 0+170 (both โล) and house-only มังคุด 4 กก.
    expect((normalized.match(/รวม \(กก\.\)/g) ?? []).length).toBe(1);
    expect(normalized).toContain("รวม (กก.) 4 180.1 184.1");
    expect(normalized).toContain("รวม (ลูก) 40 372 412");
  });

  test("never clips stock rows: tall tables split across pages and headings keep their rows", async () => {
    const empty = { count: 0, productNames: [], items: [] };
    const items = Array.from({ length: 15 }, (_, i) => ({
      productName: `สินค้าทดสอบ${i} ชื่อยาวมากเป็นพิเศษสำหรับทดสอบการตัดบรรทัดในตาราง`,
      originalProductName: null, category: "อื่นๆ", unit: "ถุง", uncertaintyReasons: [],
      marketStockQuantity: i + 1, houseStockQuantity: null, totalRemainingQuantity: null,
    }));
    const tall: MorningBriefReport = {
      ...report,
      purchasePlanning: { strong: { count: items.length, productNames: [], items }, surplus: empty, reduce: empty, unknown: empty },
      houseStock: { status: "missing" },
    };
    const doc = MorningBriefA4Doc({ report: tall, generatedAt: new Date("2026-09-20T08:00:00+07:00") });

    // Structure: no unbreakable block contains a stock or market table, and
    // every section heading asks react-pdf to keep rows after it.
    const unbreakable: string[] = [];
    const headingPresence: number[] = [];
    let wordBoundaries = 0;
    const walk = (node: React.ReactNode): void => {
      if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (!React.isValidElement(node)) return;
      const element = node as React.ReactElement<Record<string, unknown>>;
      if (typeof element.type === "function") {
        return walk((element.type as (props: Record<string, unknown>) => React.ReactNode)(element.props));
      }
      const props = element.props as { wrap?: boolean; minPresenceAhead?: number; children?: React.ReactNode; style?: { fontSize?: number } };
      if (props.style?.fontSize === 0.01) {
        expect(props.children).toBe(" ");
        wordBoundaries++;
      }
      const text = collectText(props.children);
      if (props.wrap === false) unbreakable.push(text);
      if (props.wrap === false && props.minPresenceAhead != null && text.includes("รวมคงเหลือ =")) headingPresence.push(props.minPresenceAhead);
      walk(props.children);
    };
    walk(doc);
    expect(wordBoundaries).toBeGreaterThan(0);
    expect(unbreakable.some(text => text.includes("สินค้าทดสอบ14") && text.includes("รวม (ถุง)"))).toBe(true);
    expect(unbreakable.some((text) => text.includes("สินค้าทดสอบ0") && text.includes("สินค้าทดสอบ1"))).toBe(false);
    // Market and stock rows are individually wrappable, never locked into
    // one huge container that could clip later pages.
    expect(unbreakable.some((text) => text.includes("ทรัพย์พันธ์2") && text.includes("พาซิโอ้ผลไม้"))).toBe(false);
    expect(headingPresence.length).toBeGreaterThanOrEqual(1);
    // Finance-only categories legitimately have minPresenceAhead=0 (no stock table).
    expect(headingPresence.some((points) => points >= 70)).toBe(true);
    expect(headingPresence.every((points) => points === 0 || points >= 70)).toBe(true);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      registerFonts();
      const pdf = await renderToBuffer(doc);
      expect((pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(2);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.filter((warning) => warning.includes("can't wrap"))).toEqual([]);
    for (const item of items) expect(collectText(doc).replace(/\s+/g, "")).toContain(item.productName.replace(/\s+/g, ""));
  });
});
