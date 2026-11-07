import { beforeEach, describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CascadingSlipExtractor } from "./cascade-extractor";
import { ExtractionHttpError, type SlipExtractor } from "./extractor";
import type { SlipExtraction } from "./extraction-schema";
import { GeminiQuotaUnavailableError, type GeminiRequestPermit } from "./gemini-rate-limit";
import {
  GeminiFirstSlipExtractor,
  createSlipOcrExtractor,
  resetSlipOcrFactoryWarningsForTests,
  type GeminiBuildOptions,
  type SlipOcrExtractorDeps,
} from "./ocr-extractor-factory";

const supabase = {} as SupabaseClient;
const input = { bytes: new Uint8Array([1]), mimeType: "image/jpeg" };
const good: SlipExtraction = {
  slipType: "BANK_SLIP_NO_QR", grossAmount: null, discountAmount: null, paidAmount: null,
  transferAmount: 268, referenceId: "ref-268", transactionTime: "2026-09-21T12:00:00.000Z",
  senderName: "sender", receiverName: "receiver", receiverAccountTail: "1234",
  paymentChannelText: null, headlineTotalAmount: null, confidence: 0.95,
};
const lowConfidence: SlipExtraction = { ...good, transferAmount: null, confidence: 0.2 };
const openAiRead: SlipExtraction = { ...good, referenceId: "openai" };

const ON = { SLIP_GEMINI_OCR_ENABLED: "true", GEMINI_API_KEY: "g-key", OPENAI_API_KEY: "o-key" };

function harness(geminiResult: SlipExtraction | Error = good) {
  const calls = { geminiBuilt: 0, gemini: 0, openAiBuilt: 0, openAi: 0, permits: 0 };
  let buildOptions: GeminiBuildOptions | null = null;
  const permit: GeminiRequestPermit = async () => {};
  const deps: SlipOcrExtractorDeps = {
    createPermit: () => { calls.permits++; return permit; },
    buildGemini: (options) => {
      calls.geminiBuilt++;
      buildOptions = options;
      return {
        async extract() {
          calls.gemini++;
          if (geminiResult instanceof Error) throw geminiResult;
          return geminiResult;
        },
      };
    },
    buildOpenAi: (): SlipExtractor => {
      calls.openAiBuilt++;
      return { async extract() { calls.openAi++; return openAiRead; } };
    },
  };
  return { calls, deps, permit, getBuildOptions: () => buildOptions };
}

beforeEach(() => resetSlipOcrFactoryWarningsForTests());

describe("createSlipOcrExtractor", () => {
  it("flag off: legacy OpenAI only, Gemini never built or called", async () => {
    const h = harness();
    const extractor = createSlipOcrExtractor(supabase, { GEMINI_API_KEY: "g-key", OPENAI_API_KEY: "o-key" }, h.deps);
    expect(await extractor.extract(input)).toBe(openAiRead);
    expect(h.calls).toEqual({ geminiBuilt: 0, gemini: 0, openAiBuilt: 1, openAi: 1, permits: 0 });
  });

  it("flag must be exactly 'true'", async () => {
    const h = harness();
    await createSlipOcrExtractor(supabase, { ...ON, SLIP_GEMINI_OCR_ENABLED: "1" }, h.deps).extract(input);
    expect(h.calls.geminiBuilt).toBe(0);
    expect(h.calls.openAi).toBe(1);
  });

  it("flag off with default deps returns the legacy CascadingSlipExtractor", () => {
    expect(createSlipOcrExtractor(supabase, {})).toBeInstanceOf(CascadingSlipExtractor);
  });

  it("flag on: Gemini called with permit + model, OpenAI not built or called on success", async () => {
    const h = harness();
    const extractor = createSlipOcrExtractor(supabase, { ...ON, SLIP_GEMINI_MODEL: "gemini-x" }, h.deps);
    expect(extractor).toBeInstanceOf(GeminiFirstSlipExtractor);
    expect(await extractor.extract(input)).toBe(good);
    expect(h.calls).toEqual({ geminiBuilt: 1, gemini: 1, openAiBuilt: 0, openAi: 0, permits: 1 });
    expect(h.getBuildOptions()).toEqual({ apiKey: "g-key", model: "gemini-x", acquirePermit: h.permit, jobTimeoutMs: 15_000 });
  });

  it("flag on without SLIP_GEMINI_MODEL leaves the model to the extractor default", async () => {
    const h = harness();
    createSlipOcrExtractor(supabase, ON, h.deps);
    expect(h.getBuildOptions()?.model).toBeUndefined();
  });

  it("Gemini low-confidence result is final: no OpenAI call", async () => {
    const h = harness(lowConfidence);
    expect(await createSlipOcrExtractor(supabase, ON, h.deps).extract(input)).toBe(lowConfidence);
    expect(h.calls.openAi).toBe(0);
    expect(h.calls.openAiBuilt).toBe(0);
  });

  for (const reason of ["rpm", "rpd", "limiter_error"] as const) {
    it(`Gemini quota unavailable (${reason}) falls back to OpenAI exactly once`, async () => {
      const h = harness(new GeminiQuotaUnavailableError(reason));
      expect(await createSlipOcrExtractor(supabase, ON, h.deps).extract(input)).toBe(openAiRead);
      expect(h.calls.gemini).toBe(1);
      expect(h.calls.openAi).toBe(1);
    });
  }

  it("Gemini HTTP / generic errors also fall back to OpenAI once", async () => {
    for (const err of [new ExtractionHttpError(503, "upstream_error", true, "", 1), new Error("timeout")]) {
      const h = harness(err);
      expect(await createSlipOcrExtractor(supabase, ON, h.deps).extract(input)).toBe(openAiRead);
      expect(h.calls.openAi).toBe(1);
    }
  });

  it("Gemini throws and fallback disabled by flag: rethrows, OpenAI not called", async () => {
    const err = new GeminiQuotaUnavailableError("rpd");
    const h = harness(err);
    const extractor = createSlipOcrExtractor(supabase, { ...ON, SLIP_GEMINI_OPENAI_FALLBACK: "false" }, h.deps);
    await expect(extractor.extract(input)).rejects.toBe(err);
    expect(h.calls.openAiBuilt).toBe(0);
    expect(h.calls.openAi).toBe(0);
  });

  it("Gemini throws and OPENAI_API_KEY missing: rethrows, OpenAI not called", async () => {
    const err = new Error("boom");
    const h = harness(err);
    const extractor = createSlipOcrExtractor(supabase, { ...ON, OPENAI_API_KEY: "  " }, h.deps);
    await expect(extractor.extract(input)).rejects.toBe(err);
    expect(h.calls.openAi).toBe(0);
  });

  it("flag on but GEMINI_API_KEY missing: legacy OpenAI path, Gemini never built", async () => {
    const h = harness();
    const extractor = createSlipOcrExtractor(supabase, { ...ON, GEMINI_API_KEY: "" }, h.deps);
    expect(await extractor.extract(input)).toBe(openAiRead);
    expect(h.calls.geminiBuilt).toBe(0);
    expect(h.calls.permits).toBe(0);
  });

  it("does no network or extraction work at construction", () => {
    const h = harness();
    createSlipOcrExtractor(supabase, ON, h.deps);
    expect(h.calls.gemini).toBe(0);
    expect(h.calls.openAiBuilt).toBe(0);
  });

  it("job budget: Gemini gets one call (15s) with fallback, the full 30s cap without", () => {
    const withFallback = harness();
    createSlipOcrExtractor(supabase, ON, withFallback.deps);
    expect(withFallback.getBuildOptions()?.jobTimeoutMs).toBe(15_000);
    const noFallback = harness();
    createSlipOcrExtractor(supabase, { ...ON, SLIP_GEMINI_OPENAI_FALLBACK: "false" }, noFallback.deps);
    expect(noFallback.getBuildOptions()?.jobTimeoutMs).toBe(30_000);
  });

  it("OpenAI fallback is cut at the whole-job cap, never past it", async () => {
    let clock = 0;
    const gemini: SlipExtractor = { extract: async () => { clock = 29_990; throw new Error("gemini down"); } };
    const hangingOpenAi: SlipExtractor = { extract: () => new Promise<SlipExtraction>(() => {}) };
    const extractor = new GeminiFirstSlipExtractor(gemini, () => hangingOpenAi, 30_000, () => clock);
    await expect(extractor.extract(input)).rejects.toThrow("ocr_fallback timed out");
  });
});
