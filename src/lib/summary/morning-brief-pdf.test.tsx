import React from "react";
import { describe, expect, test } from "bun:test";
import { renderToBuffer } from "@react-pdf/renderer";
import { registerFonts } from "@/lib/pdf/fonts";
import { MorningBriefA4Doc } from "@/lib/pdf/MorningBriefA4Doc";
import type { MorningBriefReport } from "@/lib/summary/morning-brief";
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

describe("Morning Brief A4 PDF", () => {
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

  test("shows yesterday sales total in the top KPI row", () => {
    const text = collectText(MorningBriefA4Doc({ report, generatedAt: new Date("2026-09-19T08:00:00+07:00") }));
    expect(text).toContain("ยอดขายรวมเมื่อวาน");
    expect(text).toContain("22,511.58");
  });

  test("keeps the right KPI compact and uses the exact explanation heading", () => {
    const text = collectText(MorningBriefA4Doc({ report, generatedAt: new Date("2026-09-19T08:00:00+07:00") }));
    expect(text).toContain("คงเหลือพร้อมขาย");
    expect(text).toContain("ชั่งคืนดีจากตลาด + Stock บ้าน");
    expect(text).not.toContain("คงเหลือพร้อมขาย (ชั่งคืนดี + บ้าน)");
    expect(text).toContain("คำอธิบายตัวเลข");
    expect(text).not.toContain("คำอธิบายตัวเลขสำคัญ");
    expect(text).toContain("มูลค่าสินค้าที่นำออกตลาดก่อนเริ่มขาย");
  });

  test("uses the requested stock columns and remaps บ้านเจ๊, market, then total", () => {
    const layoutReport: MorningBriefReport = { ...report, businessDate: "2026-09-22" };
    const text = collectText(MorningBriefA4Doc({ report: layoutReport, generatedAt: new Date("2026-09-23T08:00:00+07:00") }));
    const normalized = text.replace(/\s+/g, " ").trim();
    expect(normalized).toContain("หมวดผลไม้ - 22 กันยายน 2569");

    expect(normalized).toContain("รายการ บ้านเจ๊ ในตลาด รวมคงเหลือ");

    const apple = text.indexOf("แอปเปิ้ล");
    const house = text.indexOf("40", apple);
    const market = text.indexOf("372", house);
    const total = text.indexOf("412", market);
    expect(apple).toBeGreaterThanOrEqual(0);
    expect(house).toBeGreaterThan(apple);
    expect(market).toBeGreaterThan(house);
    expect(total).toBeGreaterThan(market);
  });

  test("renders all fixed categories in order and keeps house-only products visible", () => {
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
      "หมวดทุเรียน - 19 กันยายน 2569",
      "หมวดผัก - 19 กันยายน 2569",
      "หมวดของแห้ง - 19 กันยายน 2569",
      "หมวดยังไม่ได้จัดหมวดหมู่ - 19 กันยายน 2569",
    ];
    const positions = headings.map((heading) => text.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(text.indexOf("เห็ดนางฟ้า")).toBeGreaterThan(text.indexOf("หมวดผัก"));
    expect(text.indexOf("ปลาทู")).toBeGreaterThan(text.indexOf("หมวดของแห้ง"));
    expect(text.indexOf("สินค้าใหม่")).toBeGreaterThan(text.indexOf("หมวดยังไม่ได้จัดหมวดหมู่"));
  });

  test("splits a long category after every 15 item rows", async () => {
    const items = Array.from({ length: 31 }, (_, index) => ({
      productName: `ผลไม้ทดสอบ${index + 1}`,
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
    expect(text).toContain("หมวดผลไม้ 1/3 - 19 กันยายน 2569");
    expect(text).toContain("หมวดผลไม้ 2/3 - 19 กันยายน 2569");
    expect(text).toContain("หมวดผลไม้ 3/3 - 19 กันยายน 2569");

    registerFonts();
    const buffer = await renderToBuffer(
      <MorningBriefA4Doc report={pagedReport} generatedAt={new Date("2026-09-20T08:00:00+07:00")} />,
    );
    expect((buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(8);
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

  test("renders the fruit summary page followed by all five category pages", async () => {
    registerFonts();
    const buffer = await renderToBuffer(
      <MorningBriefA4Doc report={report} generatedAt={new Date("2026-09-19T08:00:00+07:00")} />,
    );
    expect(buffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(5_000);
    expect((buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(6);
  });
});
