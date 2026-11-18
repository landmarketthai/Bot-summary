/** Synthetic only. No service client, env file, network or storage calls. */
import React from "react";
import { mkdirSync, writeFileSync } from "node:fs";
import { renderToBuffer } from "@react-pdf/renderer";
import { MorningBriefA4Doc } from "../src/lib/pdf/MorningBriefA4Doc";
import { registerFonts } from "../src/lib/pdf/fonts";
import { DATE, scopeFixture } from "../docs/handoffs/split-morning-brief-20261021/fixtures";
import { loadMorningBriefReport } from "../src/lib/summary/morning-brief-service";
import { PRODUCT_CODE_ENTRIES } from "../src/lib/produce/product-code/dictionary";
import { produceSectionOf } from "../src/lib/summary/produce-section";

const directory = "output/pdf/morning-brief-v3";
mkdirSync(directory, { recursive: true });
registerFonts();
for (const scope of ["fruit", "vegetable"] as const) {
  for (const variant of ["normal", "overflow", "stress"] as const) {
    const report = await loadMorningBriefReport(scopeFixture({ damage: true }).client, DATE, scope);
    if (variant === "normal" && scope === "fruit") {
      const review = await loadMorningBriefReport(scopeFixture({ alias: "พาซิโอ้" }).client, DATE, "fruit");
      report.unassigned = review.unassigned;
    }
    const entries = PRODUCT_CODE_ENTRIES.filter((entry) => entry.enabled && produceSectionOf(entry.canonicalName) === scope);
    if (variant === "stress") entries.sort((a, b) => b.canonicalName.length - a.canonicalName.length);
    const names = entries.slice(0, variant === "overflow" ? 48 : variant === "stress" ? 16 : 6).map((entry) => entry.canonicalName);
    const items = names.map((productName, index) => ({
      productName, originalProductName: null, category: scope === "fruit" ? "ผลไม้" : "ผัก",
      unit: index % 3 === 0 ? "ลูก" : "โล", uncertaintyReasons: [],
      marketStockQuantity: index === 0 ? 0 : variant === "stress" && index === 1 ? undefined : variant === "stress" && index === 2 ? 123456.789 : index + 0.125,
      houseStockQuantity: scope === "vegetable" ? null : index === 1 ? 0 : index + 1,
      totalRemainingQuantity: scope === "vegetable" ? null : index === 1 ? 1.125 : index === 0 ? 1 : 2 * index + 1.125,
    }));
    report.purchasePlanning = { strong: { count: items.length, productNames: names, items },
      surplus: { count: 0, productNames: [] }, reduce: { count: 0, productNames: [] }, unknown: { count: 0, productNames: [] } };
    report.houseStock = scope === "fruit" ? { status: "available", groupCount: 0, totalValueSatang: 0, items: [] } : { status: "missing" };
    if (variant === "stress") {
      for (const item of items) item.totalRemainingQuantity = item.houseStockQuantity == null || item.marketStockQuantity == null
        ? null : (Math.round(item.houseStockQuantity * 1000) + Math.round(item.marketStockQuantity * 1000)) / 1000;
      const template = report.sales.markets![0];
      report.sales.markets = Array.from({ length: 30 }, (_, index) => ({ ...template,
        marketLabel: `ตลาดสังเคราะห์ชื่อยาว ${index + 1}`, confirmedSalesSatang: index === 0 ? -12345 : index * 1234567,
        totalSalesSatang: index === 0 ? -12345 : index * 1234567,
      }));
      report.sales.confirmedSalesSatang = report.sales.markets.reduce((sum, market) => sum + market.confirmedSalesSatang, 0);
      report.sales.totalSalesSatang = report.sales.confirmedSalesSatang;
    }
    const name = `${scope}${variant === "normal" ? "" : `-${variant}`}`;
    const snapshot = JSON.stringify(report);
    writeFileSync(`${directory}/${name}.pdf`, await renderToBuffer(<MorningBriefA4Doc report={report} generatedAt={new Date("2026-11-17T07:00:00Z")} />));
    if (JSON.stringify(report) !== snapshot) throw new Error(`PDF mutated ${name}`);
    writeFileSync(`${directory}/${name}.synthetic.json`, JSON.stringify({ report, expectedProducts: names }, null, 2));
    console.log(`${name}: ${items.length} synthetic products`);
  }
}
