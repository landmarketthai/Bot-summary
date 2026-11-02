import { describe, expect, test } from "bun:test";
import type { SlipExtraction } from "@/lib/slips/extraction-schema";
import { ExtractionHttpError } from "@/lib/slips/extractor";
import {
  GeminiSlipExtractor,
  buildGeminiRequestBody,
  readProviderUsage,
} from "@/lib/slips/gemini-extractor";
import { groupsFor, scoreAgreement, scoreModel, type EvalItem, type RunRecord } from "@/lib/slips/ocr-eval";

const bank = (amount: number | null, extra: Partial<SlipExtraction> = {}): SlipExtraction => ({
  slipType: "BANK_SLIP_QR", grossAmount: null, discountAmount: null, paidAmount: null,
  // parseSlipExtraction has already normalized the visible date to ISO.
  transferAmount: amount, referenceId: `REF-${amount}`, transactionTime: "2026-10-16T12:00:00+07:00",
  senderName: null, receiverName: null, receiverAccountTail: null,
  paymentChannelText: null, headlineTotalAmount: null, confidence: 0.95, ...extra,
});

const item = (id: string, amount: number | null, extra: Partial<EvalItem> = {}, shouldAccept = true): EvalItem => ({
  id, file: `${id}.jpg`, mimeType: "image/jpeg", batchKey: "B1", slipDate: "16/10/2569", tags: [],
  label: { slipType: "BANK_SLIP_QR", amount, dateVisible: true, referenceId: `REF-${amount}`, shouldAccept },
  ...extra,
});

const rec = (itemId: string, extraction: SlipExtraction | null, run = 1, model = "m"): RunRecord => ({
  itemId, model, run, extraction, error: extraction ? null : "boom", latencyMs: 100 * run,
  usage: { inputTokens: 2000, outputTokens: 200 },
});

describe("scoreModel uses Production's acceptance rule", () => {
  test("correct accept, wrong-amount false accept, provider error, missing date sent to review", () => {
    const items = [item("a", 100), item("b", 200), item("c", 300), item("d", 400)];
    const records = [
      rec("a", bank(100)),
      rec("b", bank(250, { referenceId: "REF-200" })), // accepted with the WRONG amount
      rec("c", null),                                  // provider failure
      rec("d", bank(400, { transactionTime: null })),  // no date: guard sends it to review
    ];
    const s = scoreModel("m", items, records, { input: 1, output: 10 });
    expect(s.correctAccept).toBe(1);
    expect(s.falseAccept).toBe(1);
    expect(s.review).toBe(2);
    expect(s.unnecessaryReview).toBe(2);
    expect(s.providerError).toBe(1);
    expect(s.missingAmount).toBe(1);
    expect(s.missingDate).toBe(2);
    // (2000 * 1 + 200 * 10) / 1e6 per call
    expect(s.avgCostUsd).toBeCloseTo(0.004, 6);
  });

  test("accepting an image the label says must be reviewed is a false accept even if the amount matches", () => {
    const s = scoreModel("m", [item("x", 500, {}, false)], [rec("x", bank(500))], null);
    expect(s.falseAccept).toBe(1);
    expect(s.correctAccept).toBe(0);
  });

  test("an in-batch duplicate: the second copy goes to review, as in Production", () => {
    const items = [item("first", 700), item("second", 700, {}, false)];
    const s = scoreModel("m", items, [rec("first", bank(700)), rec("second", bank(700))], null);
    expect(s.correctAccept).toBe(1);
    expect(s.review).toBe(1);
    expect(s.falseAccept).toBe(0);
  });

  test("consistency across runs and per-tag groups; unlabelled items are excluded", () => {
    const items = [item("a", 100, { tags: ["glare"] }), item("b", 200), { ...item("u", 1), label: null }];
    const records = [
      rec("a", bank(100), 1), rec("a", bank(110, { referenceId: "REF-100" }), 2),
      rec("b", bank(200), 1), rec("b", bank(200), 2),
      rec("u", bank(1), 1),
    ];
    const all = scoreModel("m", items, records, null);
    expect(all.items).toBe(2);
    expect(all.consistentItems).toBe(1);
    const glare = groupsFor(items).find(([g]) => g === "tag:glare")!;
    const s = scoreModel("m", items, records, null, glare[0], glare[1]);
    expect(s.items).toBe(1);
    expect(s.itemRuns).toBe(2);
    expect(s.latencyP95Ms).toBe(200);
  });
});

describe("scoreAgreement (label-free)", () => {
  test("agreement vs the stored Production result; accepted-but-disagree is counted and listed", () => {
    const items = [item("a", null), item("b", null), item("c", null)].map((i) => ({ ...i, label: null }));
    const stored = (id: string, e: SlipExtraction | null) => ({ ...rec(id, e), model: "production:stored", usage: null });
    const records = [
      stored("a", bank(100)), stored("b", bank(200)), stored("c", bank(300, { transactionTime: null })),
      rec("a", bank(100), 1, "g"), rec("a", bank(100), 2, "g"),
      rec("b", bank(210, { referenceId: "REF-200" }), 1, "g"), rec("b", bank(200), 2, "g"),
      rec("c", bank(300), 1, "g"), rec("c", bank(300), 2, "g"), // g accepts what Production sent to review
    ];
    const s = scoreAgreement("g", "production:stored", items, records, { input: 1, output: 10 });
    expect(s.items).toBe(3);
    expect(s.itemRuns).toBe(6);
    expect(s.agree).toBe(3);
    expect(s.acceptedDisagree).toBe(3);
    expect(s.consistentItems).toBe(2);
    expect(s.disagreements.map((d) => `${d.itemId}#${d.run}:${d.reference}->${d.model}`)).toEqual([
      "b#1:accept 200.00->accept 210.00",
      "c#1:review->accept 300.00",
      "c#2:review->accept 300.00",
    ]);
  });
});

describe("GeminiSlipExtractor (no network)", () => {
  const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

  test("sends the same prompt + schema and canonicalizes through parseSlipExtraction", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          slip_type: "BANK_SLIP_QR", gross_amount: null, discount_amount: null, paid_amount: null,
          project_right_amount: null, gwallet_amount: null, transfer_amount: 120.5,
          reference_id: "ABC123", transaction_time: "16 ต.ค. 69 12:00", sender_name: null,
          receiver_name: null, receiver_account_tail: null, payment_channel_text: null,
          headline_total_amount: null, confidence: 0.9,
        }) }] } }],
        usageMetadata: { promptTokenCount: 2100, candidatesTokenCount: 180, thoughtsTokenCount: 40 },
      }));
    }) as unknown as typeof fetch;
    const out = await new GeminiSlipExtractor("k", "gemini-3.8-flash", fake).extract({
      bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg",
    });
    expect(out.transferAmount).toBe(120.5);
    expect(out.referenceId).toBe("ABC123");
    expect(sent!.url).toContain("/models/gemini-3.8-flash:generateContent");
    expect((sent!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(String(sent!.init.body));
    expect(body.generationConfig.responseFormat.text.schema.properties.slip_type).toBeDefined();
    expect(body.contents[0].parts[1].inlineData.data).toBe("AQID");
  });

  test("429 is a retryable ExtractionHttpError; a missing key fails before any request", async () => {
    const err = await new GeminiSlipExtractor("k", "m", reply({}, 429) as unknown as typeof fetch)
      .extract({ bytes: new Uint8Array(), mimeType: "image/jpeg" }).catch((e) => e);
    expect(err).toBeInstanceOf(ExtractionHttpError);
    expect(err.retryable).toBe(true);
    await expect(new GeminiSlipExtractor("", "m").extract({ bytes: new Uint8Array(), mimeType: "image/jpeg" }))
      .rejects.toThrow("GEMINI_API_KEY is not configured");
  });

  test("usage: Gemini thinking tokens bill as output; OpenAI usage read from the Responses API", () => {
    expect(readProviderUsage("gemini", { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 } }))
      .toEqual({ inputTokens: 10, outputTokens: 8 });
    expect(readProviderUsage("openai", { usage: { input_tokens: 7, output_tokens: 2 } }))
      .toEqual({ inputTokens: 7, outputTokens: 2 });
    expect(buildGeminiRequestBody({ bytes: new Uint8Array(), mimeType: "image/png" })).toContain("MEDIA_RESOLUTION_HIGH");
  });
});
