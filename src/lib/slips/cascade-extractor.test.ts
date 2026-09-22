import { describe, expect, it } from "bun:test";
import { CascadingSlipExtractor } from "./cascade-extractor";
import { ExtractionHttpError, type SlipExtractor } from "./extractor";
import type { SlipExtraction } from "./extraction-schema";

const input = { bytes: new Uint8Array([1]), mimeType: "image/jpeg" };
const good: SlipExtraction = {
  slipType: "BANK_SLIP_NO_QR", grossAmount: null, discountAmount: null, paidAmount: null,
  transferAmount: 268, referenceId: "ref-268", transactionTime: "2026-09-21T12:00:00.000Z",
  senderName: "sender", receiverName: "receiver", receiverAccountTail: "1234",
  paymentChannelText: null, headlineTotalAmount: null, confidence: 0.95,
};
function fake(result: SlipExtraction | Error, calls: string[], name: string): SlipExtractor {
  return { async extract() { calls.push(name); if (result instanceof Error) throw result; return result; } };
}

describe("CascadingSlipExtractor", () => {
  it("keeps a high-confidence EXTRACTED primary read without fallback", async () => {
    const calls: string[] = [];
    const c = new CascadingSlipExtractor("primary", "fallback", m => fake(good, calls, m!));
    expect((await c.extract(input)).transferAmount).toBe(268);
    expect(calls).toEqual(["primary"]);
  });
  it("uses fallback for low-confidence primary reads", async () => {
    const calls: string[] = [];
    const low = { ...good, confidence: 0.4 };
    const c = new CascadingSlipExtractor("primary", "fallback", m => fake(m === "primary" ? low : good, calls, m!));
    expect((await c.extract(input)).confidence).toBe(0.95);
    expect(calls).toEqual(["primary", "fallback"]);
  });
  it("uses fallback when primary is only PARTIAL_EXTRACTED", async () => {
    const calls: string[] = [];
    const partial = { ...good, referenceId: null };
    const c = new CascadingSlipExtractor("primary", "fallback", m => fake(m === "primary" ? partial : good, calls, m!));
    await c.extract(input);
    expect(calls).toEqual(["primary", "fallback"]);
  });
  it("keeps a confident non-payment classification without fallback", async () => {
    const calls: string[] = [];
    const other = { ...good, slipType: "UNKNOWN" as const, confidence: 0.95 };
    const c = new CascadingSlipExtractor("primary", "fallback", m => fake(m === "primary" ? other : good, calls, m!));
    const result = await c.extract(input);
    expect(result.slipType).toBe("UNKNOWN");
    expect(calls).toEqual(["primary"]);
  });
  it("falls back after retryable provider failure", async () => {
    const calls: string[] = [];
    const err = new ExtractionHttpError(503, "upstream_error", true, "boom", 1);
    const c = new CascadingSlipExtractor("primary", "fallback", m => fake(m === "primary" ? err : good, calls, m!));
    await c.extract(input);
    expect(calls).toEqual(["primary", "fallback"]);
  });
  it("does not mask non-retryable provider failure", async () => {
    const calls: string[] = [];
    const err = new ExtractionHttpError(400, "bad_request", false, "boom", 1);
    const c = new CascadingSlipExtractor("primary", "fallback", m => fake(m === "primary" ? err : good, calls, m!));
    await expect(c.extract(input)).rejects.toThrow();
    expect(calls).toEqual(["primary"]);
  });
});
