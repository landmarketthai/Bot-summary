import { renderToBuffer } from "@react-pdf/renderer";
import { MorningBriefA4Doc } from "../../../src/lib/pdf/MorningBriefA4Doc";
import { registerFonts } from "../../../src/lib/pdf/fonts";
import { loadMorningBriefReport } from "../../../src/lib/summary/morning-brief-service";
import { buildMorningBriefReferenceData, morningBriefPdfFilename, morningBriefPdfPath } from "../../../src/lib/summary/morning-brief-pdf";
import { DATE, scopeFixture } from "./fixtures";

registerFonts();
const generatedAt = new Date("2026-10-20T13:00:00+07:00");
for (const [name, options, scope] of [
  ["fruit", { damage: true }, "fruit"],
  ["vegetable", { damage: true }, "vegetable"],
  ["vegetable-review", { pending: true }, "vegetable"],
  ["vegetable-unavailable", { invalidQuantity: true }, "vegetable"],
] as const) {
  const report = await loadMorningBriefReport(scopeFixture(options).client, DATE, scope);
  const before = JSON.stringify(report);
  const pdf = await renderToBuffer(MorningBriefA4Doc({ report, generatedAt }));
  if (JSON.stringify(report) !== before) throw new Error("renderer mutated report");
  await Bun.write(`${import.meta.dir}/pdf/${name}.pdf`, pdf);
  await Bun.write(`${import.meta.dir}/${name}.ref.json`, JSON.stringify(buildMorningBriefReferenceData(report, generatedAt, {
    bucket: "morning-brief-pdfs", path: morningBriefPdfPath(DATE, scope), filename: morningBriefPdfFilename(DATE, scope),
  }), null, 2) + "\n");
  console.log(name, "pages", (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length);
}
