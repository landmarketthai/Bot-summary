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
    strong: { count: 2, productNames: ["พุทราจีน", "แอปเปิ้ล"] },
    surplus: { count: 1, productNames: ["แก้วมังกร"] },
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
};

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

  test("renders a real PDF buffer with Thai content", async () => {
    registerFonts();
    const buffer = await renderToBuffer(
      <MorningBriefA4Doc report={report} generatedAt={new Date("2026-09-19T08:00:00+07:00")} />,
    );
    expect(buffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(5_000);
    expect((buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(2);
  });
});
