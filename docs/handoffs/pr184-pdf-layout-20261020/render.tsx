import { renderToBuffer } from "@react-pdf/renderer";
import { MorningBriefA4Doc } from "../../../src/lib/pdf/MorningBriefA4Doc";
import { registerFonts } from "../../../src/lib/pdf/fonts";
import type { MorningBriefReport } from "../../../src/lib/summary/morning-brief";
import { morningBriefLayoutFixture } from "./fixtures";

const root = process.env.PR184_PDF_OUTPUT ?? import.meta.dir;
const load = (name: string): Promise<MorningBriefReport> =>
  Bun.file(`${import.meta.dir}/../pr184-uat-20261020/${name}.report.json`).json();
const before = await load("before-return");
const after = await load("after-return");

registerFonts();
for (const [name, report] of Object.entries({ "before-return": before, "after-return": after,
  "multi-market": morningBriefLayoutFixture(after, 3, 6, 3, 2), "overflow": morningBriefLayoutFixture(after, 30, 48, 12, 4) })) {
  const snapshot = JSON.stringify(report);
  const pdf = await renderToBuffer(MorningBriefA4Doc({ report, generatedAt: new Date("2026-10-20T12:15:00+07:00") }));
  if (JSON.stringify(report) !== snapshot) throw new Error(`${name}: renderer mutated input`);
  await Bun.write(`${root}/pdf/${name}.pdf`, pdf);
  if (name === "multi-market" || name === "overflow") await Bun.write(`${root}/${name}.report.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(name, "pages", (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length);
}
