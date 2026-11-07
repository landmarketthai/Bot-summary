import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { logger } from "@/lib/logger";
import { ExtractionHttpError, type SlipExtractor } from "./extractor";
import type { SlipExtraction } from "./extraction-schema";
import {
  GeminiFirstSlipExtractor,
  SLIP_GEMINI_OCR_ENABLED_ENV,
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
const legacyRead: SlipExtraction = { ...geminiRead, referenceId: "ref-legacy", transferAmount: 300 };

function fake(result: SlipExtraction | Error, calls: string[], name: string): SlipExtractor {
  return { async extract() { calls.push(name); if (result instanceof Error) throw result; return result; } };
}

const SECRET = "sk-secret-AIzaFAKEKEY123";

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

describe("createProductionSlipExtractor", () => {
  it("flag off returns legacy and never constructs Gemini", async () => {
    const calls: string[] = [];
    let geminiBuilt = 0;
    const legacy = fake(legacyRead, calls, "legacy");
    const extractor = createProductionSlipExtractor({ GEMINI_API_KEY: "k" }, {
      gemini: () => { geminiBuilt++; return fake(geminiRead, calls, "gemini"); },
      legacy: () => legacy,
    });
    expect(extractor).toBe(legacy);
    expect(geminiBuilt).toBe(0);
    expect((await extractor.extract(input)).referenceId).toBe("ref-legacy");
    expect(calls).toEqual(["legacy"]);
  });

  it("flag on with missing key returns legacy, warns, never constructs Gemini", () => {
    let geminiBuilt = 0;
    const legacy = fake(legacyRead, [], "legacy");
    for (const key of [undefined, "", "   "]) {
      const extractor = createProductionSlipExtractor(
        { [SLIP_GEMINI_OCR_ENABLED_ENV]: "true", GEMINI_API_KEY: key },
        { gemini: () => { geminiBuilt++; return legacy; }, legacy: () => legacy },
      );
      expect(extractor).toBe(legacy);
    }
    expect(geminiBuilt).toBe(0);
    expect(logs.filter(l => l.level === "warn")).toHaveLength(3);
  });

  it("flag on with key uses Gemini primary and skips legacy on success", async () => {
    const calls: string[] = [];
    const extractor = createProductionSlipExtractor(
      { [SLIP_GEMINI_OCR_ENABLED_ENV]: "true", GEMINI_API_KEY: "k" },
      { gemini: () => fake(geminiRead, calls, "gemini"), legacy: () => fake(legacyRead, calls, "legacy") },
    );
    expect(extractor).toBeInstanceOf(GeminiFirstSlipExtractor);
    expect(await extractor.extract(input)).toEqual(geminiRead);
    expect(calls).toEqual(["gemini"]);
  });

  it("default construction with empty env does not throw", () => {
    expect(() => createProductionSlipExtractor({})).not.toThrow();
  });
});

describe("GeminiFirstSlipExtractor", () => {
  it("returns the primary result as-is with no second call", async () => {
    const calls: string[] = [];
    const lowConfidence = { ...geminiRead, confidence: 0.2 };
    const c = new GeminiFirstSlipExtractor(fake(lowConfidence, calls, "gemini"), fake(legacyRead, calls, "legacy"));
    expect(await c.extract(input)).toBe(lowConfidence);
    expect(calls).toEqual(["gemini"]);
  });

  it("falls back once on 429 and returns the legacy result", async () => {
    const calls: string[] = [];
    const err = new ExtractionHttpError(429, "rate_limit", true, `body ${SECRET}`, 10);
    const c = new GeminiFirstSlipExtractor(fake(err, calls, "gemini"), fake(legacyRead, calls, "legacy"));
    expect(await c.extract(input)).toBe(legacyRead);
    expect(calls).toEqual(["gemini", "legacy"]);
    const warn = logs.find(l => l.level === "warn");
    expect(warn?.ctx).toEqual({ provider: "gemini", httpStatus: 429, failureCode: "rate_limit", retryable: true });
  });

  for (const [label, err, reason] of [
    ["503", new ExtractionHttpError(503, "upstream_error", true, "x", 10), undefined],
    ["timeout", new ExtractionHttpError(0, "timeout", true, "", 30000), undefined],
    ["invalid output", new Error("Image extraction provider returned invalid JSON"), "invalid_output"],
    ["missing key", new Error("GEMINI_API_KEY is not configured"), "not_configured"],
  ] as const) {
    it(`falls back exactly once on ${label}`, async () => {
      const calls: string[] = [];
      const c = new GeminiFirstSlipExtractor(fake(err, calls, "gemini"), fake(legacyRead, calls, "legacy"));
      expect(await c.extract(input)).toBe(legacyRead);
      expect(calls).toEqual(["gemini", "legacy"]);
      if (reason) expect(logs.find(l => l.level === "warn")?.ctx).toEqual({ provider: "gemini", reason });
    });
  }

  it("propagates the fallback error unchanged when both fail", async () => {
    const calls: string[] = [];
    const legacyErr = new ExtractionHttpError(500, "upstream_error", true, "x", 10);
    const c = new GeminiFirstSlipExtractor(
      fake(new Error("gemini down"), calls, "gemini"),
      fake(legacyErr, calls, "legacy"),
    );
    await expect(c.extract(input)).rejects.toBe(legacyErr);
    expect(calls).toEqual(["gemini", "legacy"]);
  });

  it("never logs raw error text that may contain secrets", async () => {
    const calls: string[] = [];
    const c = new GeminiFirstSlipExtractor(
      fake(new Error(`request failed key=${SECRET} provider body {...}`), calls, "gemini"),
      fake(legacyRead, calls, "legacy"),
    );
    await c.extract(input);
    const http = new GeminiFirstSlipExtractor(
      fake(new ExtractionHttpError(400, "bad_request", false, `snippet ${SECRET}`, 10), calls, "gemini"),
      fake(legacyRead, calls, "legacy"),
    );
    await http.extract(input);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("sk-secret");
    expect(logs.find(l => l.level === "warn")?.ctx).toEqual({ provider: "gemini", reason: "unknown" });
  });
});
