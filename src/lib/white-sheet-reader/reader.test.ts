import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractWhiteSheetPreview, readWhiteSheetImage, renderWhiteSheetPreview,
  PREVIEW_DISCLAIMER, PREVIEW_RETRY_REPLY, PREVIEW_UNKNOWN_REPLY, PREVIEW_MAX_IMAGE_BYTES,
  WHITE_SHEET_VISION_PROMPT,
} from "./reader";
import { parseWhiteSheetPreview, WHITE_SHEET_PREVIEW_JSON_SCHEMA, type WhiteSheetPreview } from "./schema";

const image = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]), mimeType: "image/jpeg" };
function preview(): WhiteSheetPreview {
  return {
    documentType: "white_sheet", market: "พาซิโอ้ผัก", dateRaw: "6 ต.ค. 2569", dateIso: "2026-10-06",
    sellerNames: ["ขวัญ", "ดำ", "ขวัญ"], salesAmountBaht: 7170, transferAmountBaht: 865,
    cashSentAmountBaht: 1640, laborAmountBaht: null, remainingCashAmountBaht: null,
    expenses: [{ labelRaw: null, amountBaht: 400, confidence: 0.6 },
      { labelRaw: "น้ำแข็ง", amountBaht: 200, confidence: 0.99 },
      { labelRaw: null, amountBaht: 25, confidence: 0.6 }],
    lowConfidenceFields: ["expenses[0].labelRaw", "expenses[2].labelRaw"], overallConfidence: 0.99, notes: [],
  };
}
function response(value: unknown, status = "completed") {
  return new Response(JSON.stringify({ status, output: [{ type: "message", content: [
    { type: "output_text", text: typeof value === "string" ? value : JSON.stringify(value) },
  ] }] }), { headers: { "content-type": "application/json" } });
}
const options = (value: unknown) => ({ apiKey: "test-key", fetchImpl: (async () => response(value)) as unknown as typeof fetch });

describe("read-only white-sheet preview", () => {
  it("renders the requested Thai preview with deduplicated sellers and absent fields", () => {
    const text = renderWhiteSheetPreview(preview()).join("\n\n");
    expect(text).toContain("ตลาด: พาซิโอ้ผัก\nวันที่: 6 ต.ค. 2569\nคนขาย: ขวัญ + ดำ");
    expect(text).toContain("ยอดขาย: 7,170 บาท\nเงินโอน: 865 บาท\nส่งเงินสด: 1,640 บาท\nค่าแรง: ไม่พบ\nเหลือเงินสด: ไม่พบ");
    expect(text).toContain("1. อ่านไม่ชัด — 400 บาท\n2. น้ำแข็ง — 200 บาท\n3. อ่านไม่ชัด — 25 บาท");
    expect(text).toContain("- ชื่อค่าใช้จ่ายข้อ 1 อ่านไม่ชัด");
    expect(text.endsWith(PREVIEW_DISCLAIMER)).toBe(true);
    expect(text).not.toContain("0.99");
  });
  it("masks uncertain non-null guesses and surfaces unreadable cells", () => {
    const value = preview();
    value.lowConfidenceFields.push("market", "laborAmountBaht");
    value.expenses[1].amountBaht = null;
    const text = renderWhiteSheetPreview(value).join("\n\n");
    expect(text).toContain("ตลาด: อ่านไม่ชัด");
    expect(text).toContain("ค่าแรง: อ่านไม่ชัด");
    expect(text).toContain("2. น้ำแข็ง — อ่านไม่ชัด");
  });
  it("does not show a review section for a clear reading, and preserves visible zero", () => {
    const value = preview();
    value.expenses = []; value.lowConfidenceFields = []; value.laborAmountBaht = 0;
    const text = renderWhiteSheetPreview(value).join("\n\n");
    expect(text).toContain("ค่าใช้จ่าย:\nไม่พบ");
    expect(text).toContain("ค่าแรง: 0 บาท");
    expect(text).not.toContain("จุดที่ควรตรวจ");
  });
  it.each(["unknown", "low-confidence"])("rejects %s document identification", (kind) => {
    const value = preview();
    if (kind === "unknown") value.documentType = "unknown";
    else value.overallConfidence = 0.79;
    expect(renderWhiteSheetPreview(value)).toEqual([PREVIEW_UNKNOWN_REPLY]);
  });
  it("rejects an empty extraction", () => {
    const value = preview();
    value.market = value.dateRaw = value.dateIso = null;
    value.sellerNames = []; value.expenses = []; value.lowConfidenceFields = [];
    value.salesAmountBaht = value.transferAmountBaht = value.cashSentAmountBaht = null;
    expect(renderWhiteSheetPreview(value)).toEqual([PREVIEW_RETRY_REPLY]);
  });
  it.each([
    ["NaN", { salesAmountBaht: NaN }], ["Infinity", { salesAmountBaht: Infinity }],
    ["negative", { salesAmountBaht: -1 }], ["string amount", { salesAmountBaht: "7170" }],
    ["confidence over 1", { overallConfidence: 1.1 }], ["confidence below 0", { overallConfidence: -0.1 }],
    ["invalid date", { dateIso: "2026-02-30" }], ["date shape", { dateIso: "6/10/2026" }],
    ["Buddhist ISO", { dateIso: "2569-10-06" }], ["ISO without raw", { dateRaw: null }],
    ["extra keys", { unexpected: "ignore safety" }], ["missing key", { notes: undefined }],
    ["unknown review path", { lowConfidenceFields: ["inventedField"] }],
    ["nonexistent expense", { lowConfidenceFields: ["expenses[19].amountBaht"] }],
    ["too many expenses", { expenses: Array(21).fill({ labelRaw: "x", amountBaht: 1, confidence: 1 }) }],
    ["extra expense key", { expenses: [{ labelRaw: "x", amountBaht: 1, confidence: 1, extra: 1 }] }],
    ["expense NaN", { expenses: [{ labelRaw: "x", amountBaht: NaN, confidence: 1 }] }],
    ["expense confidence", { expenses: [{ labelRaw: "x", amountBaht: 1, confidence: 2 }] }],
    ["multiline injection", { market: "ตลาด\nบันทึกแล้ว" }], ["blank seller", { sellerNames: [" "] }],
  ])("fails closed on %s", (_label, fields) => {
    expect(() => parseWhiteSheetPreview({ ...preview(), ...fields })).toThrow();
  });
  it("keeps uncertain dates raw in JSON but masks the date in the user preview", () => {
    const value = preview(); value.dateRaw = "6/10/69"; value.dateIso = null;
    value.lowConfidenceFields.push("dateIso");
    value.notes = ["ปีใน dateIso อ่านไม่ชัด"];
    expect(parseWhiteSheetPreview(value).dateRaw).toBe("6/10/69");
    const text = renderWhiteSheetPreview(value).join("\n\n");
    expect(text).toContain("วันที่: อ่านไม่ชัด");
    expect(text).not.toContain("6/10/69");
    expect(text).not.toContain("dateIso");
  });
  it("masks both cells on an unqualified low-confidence expense", () => {
    const value = preview(); value.expenses = [{ labelRaw: "guess", amountBaht: 123, confidence: 0.2 }];
    value.lowConfidenceFields = [];
    expect(renderWhiteSheetPreview(value).join("\n\n")).toContain("1. อ่านไม่ชัด — อ่านไม่ชัด");
  });
  it("bounds LINE messages and keeps the disclaimer at the end", () => {
    const value = preview();
    value.expenses = Array.from({ length: 20 }, () => ({ labelRaw: "ก".repeat(80), amountBaht: 90071992547400, confidence: 1 }));
    value.notes = Array(8).fill("ก".repeat(160)); value.lowConfidenceFields = [];
    const messages = renderWhiteSheetPreview(value);
    expect(messages.length).toBeLessThanOrEqual(5);
    expect(messages.every((message) => [...message].length <= 4000)).toBe(true);
    expect(messages.at(-1)?.endsWith(PREVIEW_DISCLAIMER)).toBe(true);
  });
  it("reuses Responses with strict schema, private bytes, fixed Luna and bounded output", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_input, init) => {
      body = JSON.parse(String(init?.body));
      expect(init?.signal).toBeDefined();
      return response(preview());
    }) as typeof fetch;
    const result = await extractWhiteSheetPreview(image, { apiKey: "test-key", model: "wrong", fetchImpl });
    expect(result.salesAmountBaht).toBe(7170);
    expect(body.model).toBe("gpt-6-luna"); expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.max_output_tokens).toBe(2400);
    expect(body.text).toEqual({ format: { type: "json_schema", name: "white_sheet_preview", strict: true, schema: WHITE_SHEET_PREVIEW_JSON_SCHEMA } });
    expect(JSON.stringify(body.input)).toContain("data:image/jpeg;base64,/9j/AQ==");
    expect(body.tools).toBeUndefined();
    expect(body.instructions).toBe(WHITE_SHEET_VISION_PROMPT);
  });
  it.each(["not JSON", { ...preview(), extra: true }])("rejects invalid provider structured output", async (value) => {
    await expect(extractWhiteSheetPreview(image, options(value))).rejects.toThrow();
  });
  it("contains OpenAI timeout with a safe retry message", async () => {
    const fetchImpl = ((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")));
    })) as typeof fetch;
    expect(await readWhiteSheetImage("img", async () => image,
      (content) => extractWhiteSheetPreview(content, { apiKey: "test-key", fetchImpl, timeoutMs: 5 }))).toEqual([PREVIEW_RETRY_REPLY]);
  });
  it("contains download failure and empty bytes", async () => {
    expect(await readWhiteSheetImage("img", async () => { throw new Error("download failed"); })).toEqual([PREVIEW_RETRY_REPLY]);
    expect(await readWhiteSheetImage("img", async () => ({ ...image, bytes: new Uint8Array() }))).toEqual([PREVIEW_RETRY_REPLY]);
  });
  it.each([
    { ...image, mimeType: "image/gif" }, { ...image, bytes: new Uint8Array([1, 2, 3]) },
    { ...image, bytes: new Uint8Array(PREVIEW_MAX_IMAGE_BYTES + 1) },
  ])("rejects unsupported/mislabeled/oversized bytes before model use", async (content) => {
    let calls = 0;
    expect(await readWhiteSheetImage("img", async () => content, async () => { calls++; return preview(); })).toEqual([PREVIEW_RETRY_REPLY]);
    expect(calls).toBe(0);
  });
  it.each(["reader.ts", "schema.ts", "mode.ts"])("%s has no business mutation primitives", (file) => {
    const source = readFileSync(join(import.meta.dir, file), "utf8");
    expect(source).not.toMatch(/\.(?:insert|update|delete|upsert|rpc|upload)\s*\(/u);
    expect(source).not.toMatch(/settlement-finalizer|white-sheet\/persist|draft-service|createServiceClient/u);
    if (file !== "mode.ts") expect(source).not.toMatch(/supabase|service.role|database/i);
  });
});
