import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyCorrectionPatch, CORRECTION_PATCH_JSON_SCHEMA, CorrectionInvalidError, CorrectionUnavailableError,
  extractCorrectionPatch, isEmptyCorrectionPatch, parseCorrectionPatch, WHITE_SHEET_CORRECTION_PROMPT,
  type CorrectionPatch,
} from "./correction";
import { applyWhiteSheetCorrection, readWhiteSheetBase, renderWhiteSheetPreview, CORRECTION_CAPTURE_FAILED_REPLY, CORRECTION_RETRY_REPLY, PREVIEW_RETRY_REPLY, PREVIEW_UNKNOWN_REPLY } from "./reader";
import { parseWhiteSheetPreview, type WhiteSheetPreview } from "./schema";

const none = { action: "none" as const };
function patchOf(fields: Partial<CorrectionPatch> = {}): CorrectionPatch {
  return {
    market: { ...none, value: null }, date: { ...none, raw: null, day: null, month: null, year: null },
    sellerNames: { ...none, value: [] },
    salesAmountBaht: { ...none, value: null }, transferAmountBaht: { ...none, value: null },
    cashSentAmountBaht: { ...none, value: null }, laborAmountBaht: { ...none, value: null },
    remainingCashAmountBaht: { ...none, value: null }, expenses: { mode: "none", items: [] }, ...fields,
  };
}
// The real Production reading: sales/transfer/cash read, everything else unclear.
function production(): WhiteSheetPreview {
  return parseWhiteSheetPreview({
    documentType: "white_sheet", market: null, dateRaw: null, dateIso: null, sellerNames: [],
    salesAmountBaht: 7170, transferAmountBaht: 865, cashSentAmountBaht: 1640, laborAmountBaht: null,
    remainingCashAmountBaht: null,
    expenses: [
      { labelRaw: null, amountBaht: 400, confidence: 0.6 }, { labelRaw: null, amountBaht: 25, confidence: 0.6 },
      { labelRaw: null, amountBaht: 40, confidence: 0.6 }, { labelRaw: null, amountBaht: null, confidence: 0.3 },
    ],
    lowConfidenceFields: ["market", "dateRaw", "dateIso", "sellerNames", "expenses[0].labelRaw", "expenses[1].labelRaw",
      "expenses[2].labelRaw", "expenses[3].labelRaw", "expenses[3].amountBaht"],
    overallConfidence: 0.95, notes: ["ตลาดอ่านไม่ชัด"],
  });
}
const realExample = patchOf({
  market: { action: "set", value: "พาสิโอ้ผัก" },
  date: { action: "set", raw: "6 ตุลาคม 2569", day: 6, month: 10, year: 2569 },
  sellerNames: { action: "set", value: ["ขวัญ", "จ๋า"] },
  expenses: { mode: "replace_all", items: [
    { position: null, label: "ให้เจ้", amount: 400 }, { position: null, label: "ของไหว้", amount: 25 },
    { position: null, label: "เทปกาว", amount: 40 }, { position: null, label: "น้ำแข็ง", amount: 200 }] },
});

describe("correction patch merge", () => {
  it("applies the real Production correction and leaves untouched fields alone", () => {
    const merged = applyCorrectionPatch(production(), realExample);
    expect(merged.market).toBe("พาซิโอ้ผัก"); // reviewed canonical spelling of พาสิโอ้ผัก
    expect(merged.dateIso).toBe("2026-10-06"); expect(merged.dateRaw).toBe("6 ตุลาคม 2569");
    expect(merged.sellerNames).toEqual(["ขวัญ", "จ๋า"]);
    expect(merged.expenses.map((row) => [row.labelRaw, row.amountBaht])).toEqual([
      ["ให้เจ้", 400], ["ของไหว้", 25], ["เทปกาว", 40], ["น้ำแข็ง", 200]]);
    expect([merged.salesAmountBaht, merged.transferAmountBaht, merged.cashSentAmountBaht]).toEqual([7170, 865, 1640]);
    expect(merged.lowConfidenceFields).toEqual([]); // every doubt was answered by the user
    expect(merged.notes).toEqual([]);
  });
  it("a full expense list replaces the old list, including more or fewer rows", () => {
    const shorter = applyCorrectionPatch(production(), patchOf({ expenses: { mode: "replace_all",
      items: [{ position: null, label: "น้ำแข็ง", amount: 200 }] } }));
    expect(shorter.expenses).toHaveLength(1);
    expect(shorter.lowConfidenceFields.some((path) => path.startsWith("expenses"))).toBe(false);
    expect(applyCorrectionPatch(production(), patchOf({ expenses: { mode: "clear_all", items: [] } })).expenses).toEqual([]);
  });
  it("ค่าใช้จ่ายข้อ 3 เทปกาว 40 patches only item 3", () => {
    const merged = applyCorrectionPatch(production(), patchOf({ expenses: { mode: "patch_items",
      items: [{ position: 3, label: "เทปกาว", amount: 40 }] } }));
    expect(merged.expenses.map((row) => row.labelRaw)).toEqual([null, null, "เทปกาว", null]);
    expect(merged.expenses[0].amountBaht).toBe(400);
    // untouched unclear cells stay unclear, the touched row is confirmed
    expect(merged.lowConfidenceFields).toContain("expenses[0].labelRaw");
    expect(merged.lowConfidenceFields).toContain("expenses[3].amountBaht");
    expect(merged.lowConfidenceFields).not.toContain("expenses[2].labelRaw");
    const text = renderWhiteSheetPreview(merged, "corrected").join("\n");
    expect(text).toContain("1. อ่านไม่ชัด — 400 บาท");
    expect(text).toContain("3. เทปกาว — 40 บาท");
    expect(text).toContain("4. อ่านไม่ชัด — อ่านไม่ชัด");
  });
  it("a single-cell item patch keeps the other cell's doubt, and a next-row position appends", () => {
    const merged = applyCorrectionPatch(production(), patchOf({ expenses: { mode: "patch_items", items: [
      { position: 4, label: "น้ำแข็ง", amount: null }, { position: 5, label: "ค่ารถ", amount: 80 }] } }));
    expect(merged.expenses[3].labelRaw).toBe("น้ำแข็ง");
    expect(merged.lowConfidenceFields).toContain("expenses[3].amountBaht");
    expect(merged.lowConfidenceFields).not.toContain("expenses[3].labelRaw");
    expect(merged.expenses[4]).toMatchObject({ labelRaw: "ค่ารถ", amountBaht: 80 });
  });
  it.each([
    ["a position that leaves a gap", { position: 7, label: "x", amount: 1 }],
    ["a new row without an amount", { position: 5, label: "x", amount: null }],
  ])("rejects %s", (_name, item) => {
    expect(() => applyCorrectionPatch(production(), patchOf({ expenses: { mode: "patch_items", items: [item] } }))).toThrow();
  });
  it("a whole-list doubt becomes per-cell doubt when only one item is patched", () => {
    const base = { ...production(), lowConfidenceFields: [...production().lowConfidenceFields, "expenses"] };
    const merged = applyCorrectionPatch(base, patchOf({ expenses: { mode: "patch_items", items: [{ position: 2, label: "ของไหว้", amount: 25 }] } }));
    expect(merged.lowConfidenceFields).not.toContain("expenses");
    expect(merged.lowConfidenceFields).toContain("expenses[0].amountBaht");
    expect(merged.lowConfidenceFields).not.toContain("expenses[1].labelRaw");
    expect(merged.lowConfidenceFields).not.toContain("expenses[1].amountBaht");
  });
  it("ค่าแรงจริง 300 changes only labor", () => {
    const before = production();
    const merged = applyCorrectionPatch(before, patchOf({ laborAmountBaht: { action: "set", value: 300 } }));
    expect(merged.laborAmountBaht).toBe(300);
    expect({ ...merged, laborAmountBaht: before.laborAmountBaht, notes: [] }).toEqual({ ...before, notes: [] });
  });
  it("distinguishes not mentioned, cleared and supplied", () => {
    const base = production();
    const cleared = applyCorrectionPatch(base, patchOf({ laborAmountBaht: { action: "clear", value: null } }));
    expect(cleared.laborAmountBaht).toBeNull();
    const text = renderWhiteSheetPreview(applyCorrectionPatch(base, patchOf({ market: { action: "clear", value: null } })), "corrected").join("\n");
    expect(text).toContain("ตลาด: ไม่พบ"); // user says empty -> absent, not unclear
    expect(renderWhiteSheetPreview(base, "corrected").join("\n")).toContain("ตลาด: อ่านไม่ชัด");
    expect(isEmptyCorrectionPatch(patchOf())).toBe(true);
    expect(isEmptyCorrectionPatch(patchOf({ laborAmountBaht: { action: "clear", value: null } }))).toBe(false);
  });
  it("corrected fields leave the low-confidence warnings; untouched unclear fields stay อ่านไม่ชัด", () => {
    const merged = applyCorrectionPatch(production(), patchOf({ date: { action: "set", raw: "6 ต.ค. 2569", day: 6, month: 10, year: 2569 } }));
    const text = renderWhiteSheetPreview(merged, "corrected").join("\n");
    expect(text).toContain("วันที่: 6 ต.ค. 2569");
    expect(text).toContain("ตลาด: อ่านไม่ชัด"); expect(text).toContain("คนขาย: อ่านไม่ชัด");
    expect(merged.lowConfidenceFields).not.toContain("dateRaw"); expect(merged.lowConfidenceFields).not.toContain("dateIso");
    expect(text).not.toContain("วันที่ อ่านไม่ชัด");
    expect(text).toContain("- ตลาด อ่านไม่ชัด"); // still listed for review
    expect(text).toContain("ค่าแรง: ไม่พบ"); // truly absent stays ไม่พบ
  });
  it.each([
    ["Buddhist era", { raw: "6/10/2569", day: 6, month: 10, year: 2569 }, "2026-10-06"],
    ["short Buddhist year", { raw: "6/10/69", day: 6, month: 10, year: 69 }, "2026-10-06"],
    ["Gregorian year", { raw: "6 Oct 2026", day: 6, month: 10, year: 2026 }, "2026-10-06"],
  ])("resolves %s dates", (_name, date, iso) => {
    expect(applyCorrectionPatch(production(), patchOf({ date: { action: "set", ...date } })).dateIso).toBe(iso);
  });
  it("never guesses a missing year, and only borrows the sheet's own year", () => {
    const noYear = patchOf({ date: { action: "set", raw: "6 ต.ค.", day: 6, month: 10, year: null } });
    const unresolved = applyCorrectionPatch(production(), noYear);
    expect(unresolved.dateIso).toBeNull(); expect(unresolved.dateRaw).toBe("6 ต.ค.");
    expect(renderWhiteSheetPreview(unresolved, "corrected").join("\n")).toContain("วันที่: 6 ต.ค.");
    const dated = { ...production(), dateRaw: "5 ต.ค. 2569", dateIso: "2026-10-05",
      lowConfidenceFields: production().lowConfidenceFields.filter((path) => !path.startsWith("date")) };
    expect(applyCorrectionPatch(dated, noYear).dateIso).toBe("2026-10-06");
  });
  it.each([
    ["impossible day", { raw: "31 ก.พ. 2569", day: 31, month: 2, year: 2569 }],
    ["unusable year", { raw: "6/10/3000", day: 6, month: 10, year: 3000 }],
  ])("rejects an %s", (_name, date) => {
    expect(() => applyCorrectionPatch(production(), patchOf({ date: { action: "set", ...date } }))).toThrow();
  });
  it("resolves market spellings through the reviewed registry without a second dictionary", () => {
    const market = (value: string) => applyCorrectionPatch(production(), patchOf({ market: { action: "set", value } })).market;
    expect(market("พาสิโอ้ผัก")).toBe("พาซิโอ้ผัก");
    expect(market("ตลาดพาสิโอ้ผัก")).toBe("พาซิโอ้ผัก");
    expect(market("ตลาดใหม่ไม่รู้จัก")).toBe("ใหม่ไม่รู้จัก"); // unknown: the user's own wording
  });
  it("de-duplicates seller names and rejects results that fail preview validation", () => {
    expect(applyCorrectionPatch(production(), patchOf({ sellerNames: { action: "set", value: ["ขวัญ", " ขวัญ ", "จ๋า"] } })).sellerNames)
      .toEqual(["ขวัญ", "จ๋า"]);
    expect(() => applyCorrectionPatch(production(), patchOf({ expenses: { mode: "replace_all",
      items: Array.from({ length: 21 }, () => ({ position: null, label: "x", amount: 1 })) } }))).toThrow();
  });
  it("never mutates the preview it was given", () => {
    const base = production(); const copy = structuredClone(base);
    applyCorrectionPatch(base, realExample);
    expect(base).toEqual(copy);
  });
});

describe("correction patch schema", () => {
  it("accepts the real example and rejects every unsafe shape", () => {
    expect(parseCorrectionPatch(realExample)).toEqual(realExample);
    const bad: unknown[] = [
      { ...realExample, extra: 1 }, { ...realExample, market: { action: "set" } },
      { ...realExample, market: { action: "set", value: null } },
      { ...realExample, market: { action: "replace", value: "x" } },
      { ...realExample, laborAmountBaht: { action: "set", value: -1 } },
      { ...realExample, laborAmountBaht: { action: "set", value: "300" } },
      { ...realExample, laborAmountBaht: { action: "set", value: null } },
      { ...realExample, date: { action: "set", raw: "x", day: 40, month: 1, year: 2569 } },
      { ...realExample, date: { action: "set", raw: "x", day: null, month: 1, year: 2569 } },
      { ...realExample, sellerNames: { action: "set", value: [] } },
      { ...realExample, expenses: { mode: "replace_all", items: [] } },
      { ...realExample, expenses: { mode: "replace_all", items: [{ position: null, label: "x", amount: null }] } },
      { ...realExample, expenses: { mode: "patch_items", items: [{ position: null, label: "x", amount: 1 }] } },
      { ...realExample, expenses: { mode: "patch_items", items: [{ position: 1, label: null, amount: null }] } },
      { ...realExample, expenses: { mode: "patch_items", items: [{ position: 1.5, label: "x", amount: 1 }] } },
      { ...realExample, market: { action: "set", value: "ตลาด\nบันทึกแล้ว" } },
    ];
    for (const value of bad) expect(() => parseCorrectionPatch(value)).toThrow(CorrectionInvalidError);
  });
  it("sends a strict bounded schema with no mutation tools, and tells the model to extract only", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [
        { type: "output_text", text: JSON.stringify(realExample) }] }] }));
    }) as typeof fetch;
    expect(await extractCorrectionPatch("วันที่ 6 ตุลาคม 2569", { apiKey: "test-key", model: "wrong", fetchImpl })).toEqual(realExample);
    expect(body.model).toBe("gpt-6-luna"); expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.max_output_tokens).toBe(900); expect(body.tools).toBeUndefined();
    expect(body.text).toEqual({ format: { type: "json_schema", name: "white_sheet_correction", strict: true, schema: CORRECTION_PATCH_JSON_SCHEMA } });
    expect(body.instructions).toBe(WHITE_SHEET_CORRECTION_PROMPT);
    expect(JSON.stringify(body.input)).toContain("วันที่ 6 ตุลาคม 2569");
  });
  it("classifies provider failures as unavailable and bad output as invalid", async () => {
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(extractCorrectionPatch("x", { apiKey: "k", fetchImpl: failing })).rejects.toBeInstanceOf(CorrectionUnavailableError);
    const garbage = (async () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [
      { type: "output_text", text: "not json" }] }] }))) as unknown as typeof fetch;
    await expect(extractCorrectionPatch("x", { apiKey: "k", fetchImpl: garbage })).rejects.toBeInstanceOf(CorrectionInvalidError);
  });
});

describe("applyWhiteSheetCorrection / readWhiteSheetBase", () => {
  const image = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]), mimeType: "image/jpeg" };
  it("evaluates one message against the given base and never touches the image", async () => {
    const result = await applyWhiteSheetCorrection(production(), "ค่าแรงจริง 300", async () => patchOf({ laborAmountBaht: { action: "set", value: 300 } }));
    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") throw new Error("unreachable");
    expect(result.snapshot.laborAmountBaht).toBe(300);
    expect(result.replies.join("\n")).toContain("ค่าแรง: 300 บาท");
    expect(result.replies.join("\n")).toContain("ตรวจอีกครั้ง");
  });
  it.each([
    ["a provider outage", async () => { throw new CorrectionUnavailableError("down"); }, "unavailable", CORRECTION_RETRY_REPLY],
    ["an invalid model answer", async () => { throw new CorrectionInvalidError("bad"); }, "failed", CORRECTION_CAPTURE_FAILED_REPLY],
    ["an unexpected error", async () => { throw new Error("boom"); }, "failed", CORRECTION_CAPTURE_FAILED_REPLY],
    ["an empty patch", async () => patchOf(), "failed", CORRECTION_CAPTURE_FAILED_REPLY],
    ["an unappliable patch", async () => patchOf({ date: { action: "set", raw: "x", day: 31, month: 2, year: 2569 } }), "failed", CORRECTION_CAPTURE_FAILED_REPLY],
  ] as const)("classifies %s", async (_name, extractPatch, outcome, reply) => {
    expect(await applyWhiteSheetCorrection(production(), "x", extractPatch)).toEqual({ outcome, replies: [reply] });
  });
  it("does not mutate the base it was given", async () => {
    const base = production(); const copy = structuredClone(base);
    await applyWhiteSheetCorrection(base, "x", async () => realExample);
    expect(base).toEqual(copy);
  });
  it("a first read becomes a base only when it is a readable white sheet", async () => {
    const download = async () => image;
    const ok = await readWhiteSheetBase("img", download, async () => production());
    expect(ok.outcome).toBe("applied");
    if (ok.outcome === "applied") expect(ok.snapshot).toEqual(production()); // the exact validated preview
    expect(await readWhiteSheetBase("img", download, async () => ({ ...production(), documentType: "unknown" })))
      .toEqual({ outcome: "failed", replies: [PREVIEW_UNKNOWN_REPLY] });
    const empty = { ...production(), market: null, dateRaw: null, dateIso: null, sellerNames: [], salesAmountBaht: null,
      transferAmountBaht: null, cashSentAmountBaht: null, expenses: [], lowConfidenceFields: [], notes: [] };
    expect(await readWhiteSheetBase("img", download, async () => empty)).toEqual({ outcome: "failed", replies: [PREVIEW_RETRY_REPLY] });
    expect(await readWhiteSheetBase("img", async () => { throw new Error("gone"); })).toEqual({ outcome: "unavailable", replies: [PREVIEW_RETRY_REPLY] });
    expect(await readWhiteSheetBase("img", download, async () => { throw new Error("timeout"); })).toEqual({ outcome: "unavailable", replies: [PREVIEW_RETRY_REPLY] });
    expect(await readWhiteSheetBase("img", download, async () => ({ invalid: true }))).toEqual({ outcome: "unavailable", replies: [PREVIEW_RETRY_REPLY] });
  });
  it("re-parsing a rendered snapshot is stable: what is stored is exactly what was shown", () => {
    const snapshot = parseWhiteSheetPreview(production());
    expect(parseWhiteSheetPreview(snapshot)).toEqual(snapshot);
    expect(renderWhiteSheetPreview(snapshot, "review")).toEqual(renderWhiteSheetPreview(parseWhiteSheetPreview(structuredClone(snapshot)), "review"));
  });
});

describe("correction module safety", () => {
  it("has no business mutation primitives and no persistence", () => {
    const source = readFileSync(join(import.meta.dir, "correction.ts"), "utf8");
    expect(source).not.toMatch(/\.(?:insert|update|delete|upsert|rpc|upload)\s*\(/u);
    expect(source).not.toMatch(/supabase|service.role|database|settlement-finalizer|white-sheet\/persist|draft-service|createServiceClient/i);
  });
});
