import { describe, expect, test } from "bun:test";
import { buildBatchSummaryMessage, type EvidenceWithCheck } from "@/lib/slips/batch-finalizer";
import { determineSlipCheckStatus, extractionToJson, parseSlipExtraction } from "@/lib/slips/extraction-schema";
import { OpenAiSlipExtractor } from "@/lib/slips/extractor";
import { computeValidationFlags, parseBatchDate } from "@/lib/slips/validation-guard";

// Anonymized replay of Production batch 5f1b8484 (market day 29/10/2569, 6 images).
// Amounts, slip types, statuses and stored times are the real stored values;
// references are fake. Image truth: every slip is dated 29 ต.ค. 2569.
const ev = (n: number, e: Partial<EvidenceWithCheck>): EvidenceWithCheck => ({
  id: `ev-${n}`, batchIndex: n, sequence: n, sequenceVerified: true,
  checkStatus: "EXTRACTED", slipType: "BANK_SLIP_QR",
  transferAmount: null, paidAmount: null, grossAmount: null, discountAmount: null,
  transactionTime: null, referenceId: `REF-${n}`, failureReason: null, ...e,
});
const BATCH = [
  ev(1, { transferAmount: 40, transactionTime: "2026-07-29T00:15:00.000Z" }),
  ev(2, { transferAmount: 50, transactionTime: "2026-10-29T08:46:31.000Z" }),
  ev(3, { transferAmount: 40, transactionTime: "2026-10-29T11:50:00.000Z" }),
  ev(4, { transferAmount: 50, transactionTime: "2026-07-29T09:37:00.000Z" }),
  ev(5, { slipType: "BANK_SLIP_NO_QR", checkStatus: "PARTIAL_EXTRACTED", transferAmount: 40, referenceId: null }),
  ev(6, {
    slipType: "GWALLET", checkStatus: "NEED_REVIEW", grossAmount: 40, referenceId: null,
    transactionTime: "2026-09-29T11:02:00.000Z",
  }),
];

describe("P0 29/10/2569 — parser layer", () => {
  test("month comes only from the transcribed text: ต.ค. -> October, ก.ค. -> July", () => {
    const t = (s: string) => parseSlipExtraction({ slip_type: "BANK_SLIP_QR", transaction_time: s }).transactionTime;
    expect(t("29 ต.ค. 2569 16:37")).toBe("2026-10-29T09:37:00.000Z");
    // The stored July value of #4 is exactly what "ก.ค." parses to, so the wrong
    // month was in the model's transcription, not added by the parser.
    expect(t("29 ก.ค. 2569 16:37")).toBe(BATCH[3].transactionTime);
    // A day-29 date cannot be read as another month by swapping day and month.
    expect(t("10/29/2569 16:37")).toBeNull();
  });

  test("formats the parser does not read stay null (fail closed, never guessed)", () => {
    const t = (s: string) => parseSlipExtraction({ slip_type: "BANK_SLIP_NO_QR", transaction_time: s }).transactionTime;
    // Printed label/spacing variants (วันที่, เวลา, ต.ค.69, 17.49) are handled in
    // PR #193's parser; these stay unreadable with or without it.
    for (const s of ["29 Oct 2026 17:49", "๒๙ ต.ค. ๖๙ ๑๗:๔๙", "29 ตค 2569 17:49", "17:49 29 ต.ค. 69"]) {
      expect(t(s)).toBeNull();
    }
  });
});

describe("P0 29/10/2569 — model provenance is persisted for new reads", () => {
  test("raw date text, raw slip type and model id survive into extracted_json; long digit runs are redacted", () => {
    const e = parseSlipExtraction({
      slip_type: "GWALLET", transaction_time: "29 ต.ค. 69 17:49 acct 1234567890", transfer_amount: 40,
    });
    const json = extractionToJson({ ...e, modelId: "gpt-6-luna" }) as Record<string, unknown>;
    expect(json.transaction_time_text).toBe("29 ต.ค. 69 17:49 acct [redacted]");
    expect(json.slip_type_raw).toBe("GWALLET");
    expect(json.model_id).toBe("gpt-6-luna");
  });

  test("an invalid raw slip type is kept as text while the business type fails closed", () => {
    const e = parseSlipExtraction({ slip_type: "BANK_TRANSFER_TO_WALLET" });
    expect(e.slipType).toBe("UNKNOWN");
    expect(e.rawSlipType).toBe("BANK_TRANSFER_TO_WALLET");
  });

  test("OpenAI extractor stamps the model that answered", async () => {
    const body = { output: [{ content: [{ type: "output_text", text: JSON.stringify({ slip_type: "BANK_SLIP_QR", confidence: 0.9 }) }] }] };
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const result = await new OpenAiSlipExtractor("test-key", "model-x", fetchImpl).extract({ bytes: new Uint8Array([1]), mimeType: "image/jpeg" });
    expect(result.modelId).toBe("model-x");
  });
});

describe("P0 29/10/2569 — classification layer", () => {
  test("#6 read as GWALLET with only a gross number stays NEED_REVIEW (no re-typing from the amount)", () => {
    const e = parseSlipExtraction({
      slip_type: "GWALLET", gross_amount: 40, paid_amount: null, discount_amount: null,
      reference_id: null, transaction_time: "29 ก.ย. 2569 18:02",
      payment_channel_text: "คนละครึ่ง พลัส / G-Wallet", confidence: 0.43,
    });
    expect(e.slipType).toBe("GWALLET");
    expect(determineSlipCheckStatus(e)).toBe("NEED_REVIEW");
  });
});

describe("P0 29/10/2569 — validation layer and LINE summary", () => {
  test("date guard is unchanged: July/no-date slips stay out of the confirmed total", () => {
    const flags = computeValidationFlags(BATCH, parseBatchDate("29/10/2569"));
    expect(flags[0].flagReasons).toEqual(["วันที่รายการไม่ตรงกับรอบ"]);
    expect(flags[3].flagReasons).toEqual(["วันที่รายการไม่ตรงกับรอบ"]);
    expect(flags[4].flagReasons).toEqual(["ไม่พบวันที่รายการ"]);
  });

  test("summary separates AI-read, confirmed and pending amounts with specific reasons", () => {
    const msg = buildBatchSummaryMessage(BATCH, { slipDate: "29/10/2569" });
    expect(msg).toContain("ยอดที่ AI อ่านได้: 260 บาท");
    expect(msg).toContain("ยอดยืนยัน: 90 บาท");
    expect(msg).toContain("ยอดรอตรวจ: 170 บาท (4 รูป) ยังไม่นับเป็นยอดยืนยัน");
    expect(msg).toContain("#2 เช็คได้ 50 บาท");
    expect(msg).toContain("#3 เช็คได้ 40 บาท");
    expect(msg).toContain("#1 อ่านได้ 40 บาท ยังไม่ยืนยัน: วันที่ในสลิป 29/07/2569 ไม่ตรงกับรอบ");
    expect(msg).toContain("#4 อ่านได้ 50 บาท ยังไม่ยืนยัน: วันที่ในสลิป 29/07/2569 ไม่ตรงกับรอบ");
    expect(msg).toContain("#5 อ่านได้ 40 บาท ยังไม่ยืนยัน: ไม่พบวันที่รายการ");
    expect(msg).toContain("#6 อ่านได้ 40 บาท ยังไม่ยืนยัน: อ่านเป็น G-Wallet แต่ข้อมูลไม่ครบ (ไม่พบยอด G-Wallet, ไม่พบเลขอ้างอิง)");
  });

  test("a duplicate is listed but its amount is not added to the AI-read or pending totals", () => {
    const dup = [
      ev(1, { transferAmount: 40, transactionTime: "2026-10-29T08:00:00.000Z", referenceId: "SAME" }),
      ev(2, { transferAmount: 40, transactionTime: "2026-10-29T08:00:00.000Z", referenceId: "SAME" }),
    ];
    const msg = buildBatchSummaryMessage(dup, { slipDate: "29/10/2569" });
    expect(msg).toContain("ยอดที่ AI อ่านได้: 40 บาท");
    expect(msg).toContain("ยอดยืนยัน: 40 บาท");
    expect(msg).not.toContain("ยอดรอตรวจ:");
    expect(msg).toContain("#2 อ่านได้ 40 บาท ยังไม่ยืนยัน: สลิปซ้ำ");
  });
});
