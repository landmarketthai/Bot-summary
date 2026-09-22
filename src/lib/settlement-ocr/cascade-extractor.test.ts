import { describe, expect, it } from "bun:test";
import { CascadingSettlementSheetExtractor } from "./cascade-extractor";
import { SettlementSheetExtractionHttpError } from "./extractor";
import type { SettlementSheetExtraction, SettlementSheetExtractionInput, SettlementSheetExtractor } from "./types";

function money(value: number | null, confidence = 0.95) {
  return { value, confidence };
}

// The P0 real handwritten-sheet example — a trustworthy, fully-confident read.
function goodExtraction(): SettlementSheetExtraction {
  return {
    documentType: "SETTLEMENT_SHEET",
    documentTypeConfidence: 0.97,
    marketText: "วัดทุ่งลานนา",
    dateText: "21/9/69",
    staffText: "กี้",
    salesTotal: money(5123),
    transferAmount: money(2123),
    cashSubmitted: money(2800),
    expensesTotal: money(200),
    expenseItems: [],
    laborTotal: money(550),
    laborItems: [],
    cashRemaining: money(2250),
  };
}

function lowConfidenceExtraction(): SettlementSheetExtraction {
  return { ...goodExtraction(), cashRemaining: money(2250, 0.1) }; // crossed-out ambiguity, say
}

function fakeExtractor(
  result: SettlementSheetExtraction | Error,
  calls: string[] = [],
  name = "extractor",
): SettlementSheetExtractor {
  return {
    async extract() {
      calls.push(name);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const INPUT: SettlementSheetExtractionInput = { bytes: new Uint8Array([1]), mimeType: "image/jpeg" };

describe("CascadingSettlementSheetExtractor", () => {
  it("default behavior is safe when the fallback env var is unset: only the primary model is ever called", async () => {
    const calls: string[] = [];
    const primary = fakeExtractor(lowConfidenceExtraction(), calls, "primary");
    const cascade = new CascadingSettlementSheetExtractor("model-a", null, () => primary);

    const result = await cascade.extract(INPUT);

    expect(calls).toEqual(["primary"]);
    expect(result.extractionPass).toBe("primary");
    expect(result.extractionModel).toBe("model-a");
    expect(result.extractionProvider).toBe("openai");
  });

  it("a trustworthy primary read is used as-is — no fallback call even when fallback is configured", async () => {
    const calls: string[] = [];
    const primary = fakeExtractor(goodExtraction(), calls, "primary");
    const fallback = fakeExtractor(goodExtraction(), calls, "fallback");
    const cascade = new CascadingSettlementSheetExtractor(
      "model-a",
      "model-b",
      (model) => (model === "model-a" ? primary : fallback),
    );

    const result = await cascade.extract(INPUT);

    expect(calls).toEqual(["primary"]);
    expect(result.extractionPass).toBe("primary");
  });

  it("low-confidence primary read triggers the fallback model, and the fallback's result is tagged", async () => {
    const calls: string[] = [];
    const primary = fakeExtractor(lowConfidenceExtraction(), calls, "primary");
    const fallback = fakeExtractor(goodExtraction(), calls, "fallback");
    const cascade = new CascadingSettlementSheetExtractor(
      "model-a",
      "model-b",
      (model) => (model === "model-a" ? primary : fallback),
    );

    const result = await cascade.extract(INPUT);

    expect(calls).toEqual(["primary", "fallback"]);
    expect(result.extractionPass).toBe("fallback");
    expect(result.extractionModel).toBe("model-b");
  });

  it("an arithmetic mismatch on the primary read also triggers the fallback model", async () => {
    const calls: string[] = [];
    const mismatched = { ...goodExtraction(), salesTotal: money(9999) };
    const primary = fakeExtractor(mismatched, calls, "primary");
    const fallback = fakeExtractor(goodExtraction(), calls, "fallback");
    const cascade = new CascadingSettlementSheetExtractor(
      "model-a",
      "model-b",
      (model) => (model === "model-a" ? primary : fallback),
    );

    const result = await cascade.extract(INPUT);

    expect(calls).toEqual(["primary", "fallback"]);
    expect(result.extractionPass).toBe("fallback");
  });

  it("a missing sales total triggers fallback instead of accepting a partial financial read", async () => {
    const calls: string[] = [];
    const primary = fakeExtractor({ ...goodExtraction(), salesTotal: money(null, 0) }, calls, "primary");
    const fallback = fakeExtractor(goodExtraction(), calls, "fallback");
    const cascade = new CascadingSettlementSheetExtractor(
      "model-a",
      "model-b",
      (model) => (model === "model-a" ? primary : fallback),
    );

    const result = await cascade.extract(INPUT);

    expect(calls).toEqual(["primary", "fallback"]);
    expect(result.extractionPass).toBe("fallback");
  });

  it("a low-confidence document classification triggers fallback before silent ignore", async () => {
    const calls: string[] = [];
    const ambiguous = { ...goodExtraction(), documentTypeConfidence: 0.1 };
    const primary = fakeExtractor(ambiguous, calls, "primary");
    const fallback = fakeExtractor(goodExtraction(), calls, "fallback");
    const cascade = new CascadingSettlementSheetExtractor(
      "model-a",
      "model-b",
      (model) => (model === "model-a" ? primary : fallback),
    );

    const result = await cascade.extract(INPUT);

    expect(calls).toEqual(["primary", "fallback"]);
    expect(result.extractionPass).toBe("fallback");
  });

  it("a confident OTHER classification skips fallback and remains cheap", async () => {
    const calls: string[] = [];
    const other = { ...goodExtraction(), documentType: "OTHER" as const, documentTypeConfidence: 0.95 };
    const primary = fakeExtractor(other, calls, "primary");
    const fallback = fakeExtractor(goodExtraction(), calls, "fallback");
    const cascade = new CascadingSettlementSheetExtractor(
      "model-a",
      "model-b",
      (model) => (model === "model-a" ? primary : fallback),
    );

    const result = await cascade.extract(INPUT);

    expect(calls).toEqual(["primary"]);
    expect(result.documentType).toBe("OTHER");
  });
  it("a retryable provider failure on the primary falls back safely", async () => {
    const calls: string[] = [];
    const httpError = new SettlementSheetExtractionHttpError(503, "upstream_error", true, "boom", 10);
    const primary = fakeExtractor(httpError, calls, "primary");
    const fallback = fakeExtractor(goodExtraction(), calls, "fallback");
    const cascade = new CascadingSettlementSheetExtractor(
      "model-a",
      "model-b",
      (model) => (model === "model-a" ? primary : fallback),
    );

    const result = await cascade.extract(INPUT);

    expect(calls).toEqual(["primary", "fallback"]);
    expect(result.extractionPass).toBe("fallback");
  });

  it("a non-retryable provider failure on the primary is never masked by a fallback attempt", async () => {
    const calls: string[] = [];
    const httpError = new SettlementSheetExtractionHttpError(400, "bad_request", false, "boom", 10);
    const primary = fakeExtractor(httpError, calls, "primary");
    const fallback = fakeExtractor(goodExtraction(), calls, "fallback");
    const cascade = new CascadingSettlementSheetExtractor(
      "model-a",
      "model-b",
      (model) => (model === "model-a" ? primary : fallback),
    );

    await expect(cascade.extract(INPUT)).rejects.toThrow();
    expect(calls).toEqual(["primary"]);
  });

  it("a provider failure with no fallback configured propagates, exactly as a single-model extractor would", async () => {
    const calls: string[] = [];
    const httpError = new SettlementSheetExtractionHttpError(503, "upstream_error", true, "boom", 10);
    const primary = fakeExtractor(httpError, calls, "primary");
    const cascade = new CascadingSettlementSheetExtractor("model-a", null, () => primary);

    await expect(cascade.extract(INPUT)).rejects.toThrow();
    expect(calls).toEqual(["primary"]);
  });
});
