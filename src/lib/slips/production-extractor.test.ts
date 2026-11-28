import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { logger } from "@/lib/logger";
import { GeminiSlipExtractor } from "./gemini-extractor";
import type { SlipExtractor } from "./extractor";
import type { SlipExtraction } from "./extraction-schema";
import {
  PRODUCTION_GEMINI_CALL_TIMEOUT_MS,
  SLIP_GEMINI_OCR_ENABLED_ENV,
  SLIP_OCR_DISABLED_MESSAGE,
  SLIP_OCR_NOT_CONFIGURED_MESSAGE,
  createProductionSlipExtractor,
  isGeminiSlipOcrEnabled,
} from "./production-extractor";

const input = { bytes: new Uint8Array([1]), mimeType: "image/jpeg" };
const geminiRead: SlipExtraction = {
  slipType: "BANK_SLIP_NO_QR", grossAmount: null, discountAmount: null, paidAmount: null,
  transferAmount: 268, referenceId: "ref-gemini", transactionTime: "2026-11-07T12:00:00.000Z",
  senderName: "sender", receiverName: "receiver", receiverAccountTail: "1234",
  paymentChannelText: null, headlineTotalAmount: null, confidence: 0.95,
};
const SECRET = "AIzaFAKEKEY123-secret";

type LogCall = { level: string; msg: string; ctx?: Record<string, unknown> };
let logs: LogCall[] = [];
const original = { info: logger.info, warn: logger.warn, error: logger.error, debug: logger.debug };

beforeEach(() => {
  logs = [];
  for (const level of ["info", "warn", "error", "debug"] as const) {
    (logger as Record<string, unknown>)[level] = (msg: string, ctx?: Record<string, unknown>) => {
      logs.push({ level, msg, ctx });
    };
  }
});
afterEach(() => {
  Object.assign(logger, original);
});

describe("isGeminiSlipOcrEnabled", () => {
  it("is on only for exact lowercase 'true' after trim", () => {
    expect(isGeminiSlipOcrEnabled({ [SLIP_GEMINI_OCR_ENABLED_ENV]: "true" })).toBe(true);
    expect(isGeminiSlipOcrEnabled({ [SLIP_GEMINI_OCR_ENABLED_ENV]: " true " })).toBe(true);
  });
  it("is off for unset, empty, and other truthy-looking values", () => {
    for (const value of [undefined, "", "TRUE", "True", "1", "yes", "on", "false"]) {
      expect(isGeminiSlipOcrEnabled({ [SLIP_GEMINI_OCR_ENABLED_ENV]: value })).toBe(false);
    }
    expect(isGeminiSlipOcrEnabled({})).toBe(false);
  });
});

describe("createProductionSlipExtractor (Gemini-only, fail closed)", () => {
  it("flag off fails closed with an actionable message and never constructs Gemini", async () => {
    for (const flag of [undefined, "", "TRUE", "1", "false"]) {
      let geminiBuilt = 0;
      const extractor = createProductionSlipExtractor(
        { [SLIP_GEMINI_OCR_ENABLED_ENV]: flag, GEMINI_API_KEY: SECRET },
        { gemini: () => { geminiBuilt++; return { extract: async () => geminiRead }; } },
      );
      await expect(extractor.extract(input)).rejects.toThrow(SLIP_OCR_DISABLED_MESSAGE);
      expect(geminiBuilt).toBe(0);
    }
    expect(SLIP_OCR_DISABLED_MESSAGE).toContain("SLIP_GEMINI_OCR_ENABLED=true");
  });

  it("flag on with missing/blank key fails closed, warns, never constructs Gemini", async () => {
    let geminiBuilt = 0;
    for (const key of [undefined, "", "   "]) {
      const extractor = createProductionSlipExtractor(
        { [SLIP_GEMINI_OCR_ENABLED_ENV]: "true", GEMINI_API_KEY: key },
        { gemini: () => { geminiBuilt++; return { extract: async () => geminiRead }; } },
      );
      await expect(extractor.extract(input)).rejects.toThrow(SLIP_OCR_NOT_CONFIGURED_MESSAGE);
    }
    expect(geminiBuilt).toBe(0);
    expect(logs.filter(l => l.level === "warn")).toHaveLength(3);
  });

  it("flag on with key returns the Gemini extractor itself, no wrapper or fallback", async () => {
    const gemini: SlipExtractor = { extract: async () => geminiRead };
    const extractor = createProductionSlipExtractor(
      { [SLIP_GEMINI_OCR_ENABLED_ENV]: "true", GEMINI_API_KEY: "k" },
      { gemini: () => gemini },
    );
    expect(extractor).toBe(gemini);
    expect(await extractor.extract(input)).toEqual(geminiRead);
  });

  it("Gemini errors propagate unchanged (no second provider)", async () => {
    const err = new Error("gemini down");
    const extractor = createProductionSlipExtractor(
      { [SLIP_GEMINI_OCR_ENABLED_ENV]: "true", GEMINI_API_KEY: "k" },
      { gemini: () => ({ extract: async () => { throw err; } }) },
    );
    await expect(extractor.extract(input)).rejects.toBe(err);
  });

  it("default Gemini is the production model with a call timeout that fits two attempts in the job", () => {
    expect(PRODUCTION_GEMINI_CALL_TIMEOUT_MS).toBe(10_000);
    const extractor = createProductionSlipExtractor({ SLIP_GEMINI_OCR_ENABLED: "true", GEMINI_API_KEY: "local-test-key" });
    expect(extractor).toBeInstanceOf(GeminiSlipExtractor);
    expect((extractor as unknown as { callTimeoutMs: number }).callTimeoutMs).toBe(10_000);
    expect((extractor as GeminiSlipExtractor).model).toBe("gemini-3.5-flash-lite");
  });

  it("disabled/missing-key logs never contain the key", () => {
    createProductionSlipExtractor({ GEMINI_API_KEY: SECRET });
    createProductionSlipExtractor({ SLIP_GEMINI_OCR_ENABLED: "true", GEMINI_API_KEY: " " });
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("default construction with empty env does not throw", () => {
    expect(() => createProductionSlipExtractor({})).not.toThrow();
  });
});

describe("OpenAI is unreachable from production slip OCR", () => {
  it("no non-test source module imports OpenAiSlipExtractor", () => {
    const sources = [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync(".")]
      .filter(f => !/\.test\.tsx?$/.test(f) && !/[\\/]slips[\\/]extractor\.ts$/.test(f));
    expect(sources.some(f => /[\\/]slips[\\/]check-service\.ts$/.test(f))).toBe(true);
    expect(sources.filter(f => readFileSync(f, "utf8").includes("OpenAiSlipExtractor"))).toEqual([]);
  });
});
