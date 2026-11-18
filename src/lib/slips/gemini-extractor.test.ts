import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { parseSlipExtraction, SLIP_EXTRACTION_JSON_SCHEMA } from "./extraction-schema";
import { ExtractionHttpError } from "./extractor";
import {
  buildGeminiRequestBody,
  DEFAULT_GEMINI_SLIP_MODEL,
  GeminiSlipExtractor,
  readGeminiOutputText,
} from "./gemini-extractor";

// Mock-only: every fetch below is a local fake. No network, no real API key.
const START = Date.UTC(2026, 10, 7);
const KEY = "fixture-key-SECRET-0000";
const PRIVATE = `${KEY} private provider text 123456789`;
const input = { bytes: new Uint8Array([1]), mimeType: "image/png" };
const valid = {
  slip_type: "GWALLET", gross_amount: 999, discount_amount: null, paid_amount: null,
  project_right_amount: 60, gwallet_amount: 40, headline_total_amount: 100,
  transfer_amount: null, reference_id: null, transaction_time: null,
  sender_name: null, receiver_name: null, receiver_account_tail: "1234",
  payment_channel_text: "ไทยช่วยไทย", confidence: 0.95,
};

function reply(value: unknown = valid): Response {
  return output(JSON.stringify(value));
}

function output(text: string): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: PRIVATE }, { text }] } }] }));
}

function fixture(
  handler: (...args: Parameters<typeof fetch>) => Promise<Response>,
  timeout = 15_000,
) {
  const fetchMock = mock(handler);
  const fetchImpl = Object.assign(fetchMock, { preconnect: () => {} });
  const extractor = new GeminiSlipExtractor(KEY, DEFAULT_GEMINI_SLIP_MODEL, fetchImpl, timeout);
  return { fetchMock, extractor };
}

// Flush promise continuations between virtual timer ticks (no wall-clock sleeps).
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function advance(ms: number) {
  await flush();
  jest.advanceTimersByTime(ms);
  await flush();
}

const never = () => new Promise<Response>(() => {});

function leaks(error: unknown): string {
  const e = error as { message?: unknown; stack?: unknown };
  return String(error) + JSON.stringify(error) + String(e?.message) + String(e?.stack);
}

describe("Gemini production adapter contract", () => {
  it("pins the default model id and keeps minimal thinking for it", () => {
    expect(DEFAULT_GEMINI_SLIP_MODEL).toBe("gemini-3.5-flash-lite");
    const body = JSON.parse(buildGeminiRequestBody(input, DEFAULT_GEMINI_SLIP_MODEL));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(body.contents[0].parts[1].inlineData).toEqual({ mimeType: "image/png", data: "AQ==" });
    expect(JSON.parse(buildGeminiRequestBody(input, "gemini-2.5-flash")).generationConfig.thinkingConfig).toBeUndefined();
  });

  it("reads only non-thought text parts", () => {
    expect(readGeminiOutputText({ candidates: [{ content: { parts: [{ thought: true, text: "x" }, { text: "y" }] } }] })).toBe("y");
    expect(readGeminiOutputText({})).toBeNull();
  });

  it("throws before any fetch when GEMINI_API_KEY is missing", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      // undefined falls back to the (now unset) env default; "" is an explicit empty key.
      for (const key of [undefined, ""]) {
        const fetchMock = mock(async () => reply());
        const fetchImpl = Object.assign(fetchMock, { preconnect: () => {} }) as unknown as typeof fetch;
        const extractor = new GeminiSlipExtractor(key, DEFAULT_GEMINI_SLIP_MODEL, fetchImpl);
        await expect(extractor.extract(input)).rejects.toThrow("GEMINI_API_KEY is not configured");
        expect(fetchMock).not.toHaveBeenCalled();
      }
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });
});

describe("Gemini bounded, mock-only retries", () => {
  beforeEach(() => jest.useFakeTimers({ now: START }));
  afterEach(() => {
    const timers = jest.getTimerCount();
    jest.useRealTimers();
    expect(timers).toBe(0);
  });

  it("success path: one call, key only in header, model in URL, canonical wallet output", async () => {
    const { extractor, fetchMock } = fixture(async () => reply());
    const result = await extractor.extract(input);
    expect(result).toEqual(parseSlipExtraction(valid));
    // ไทยช่วยไทย/G-Wallet: headline (gross) 100 preserved, 40 paid, never the 999 misread.
    expect(result).toMatchObject({ slipType: "THAI_HELP_THAI", grossAmount: 100, paidAmount: 40, receiverAccountTail: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
    expect(String(url)).not.toContain(KEY);
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    expect(String(init?.body)).not.toContain(KEY);
    expect(JSON.parse(String(init?.body)).generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: "minimal" }, maxOutputTokens: 2048,
      responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: SLIP_EXTRACTION_JSON_SCHEMA } },
    });
  });

  it.each([undefined, "1", "30"])("HTTP 429 (Retry-After %s) is thrown immediately with exactly one call (free-tier quota)", async (retryAfter) => {
    const headers: Record<string, string> = retryAfter ? { "Retry-After": retryAfter } : {};
    const { extractor, fetchMock } = fixture(async () => new Response(PRIVATE, { status: 429, headers }));
    const error = await extractor.extract(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractionHttpError);
    expect(error).toMatchObject({ httpStatus: 429, failureCode: "rate_limit", retryable: true, responseSnippet: "" });
    expect(Date.now()).toBe(START);
    expect(leaks(error)).not.toContain(KEY);
    await advance(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 503, 504])("retries HTTP %s once then returns canonical output using the same model/schema", async (status) => {
    let calls = 0;
    const times: number[] = [];
    const { extractor, fetchMock } = fixture(async () => {
      times.push(Date.now() - START);
      return ++calls === 1 ? new Response(PRIVATE, { status }) : reply();
    });
    const pending = extractor.extract(input);
    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(await pending).toEqual(parseSlipExtraction(valid));
    expect(times).toEqual([0, 1_000]);
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toEndWith("/models/gemini-3.5-flash-lite:generateContent");
    expect(init?.body).toBe(fetchMock.mock.calls[0][1]?.body);
  });

  it.each(["3", new Date(START + 3_000).toUTCString()])("honors a fitting 503 Retry-After: %s", async (retryAfter) => {
    let calls = 0;
    const { extractor, fetchMock } = fixture(async () => ++calls === 1
      ? new Response(PRIVATE, { status: 503, headers: { "Retry-After": retryAfter } }) : reply());
    const pending = extractor.extract(input);
    await advance(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(await pending).toEqual(parseSlipExtraction(valid));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["invalid", "0"])("uses bounded fallback backoff for Retry-After %s", async (retryAfter) => {
    let calls = 0;
    const { extractor } = fixture(async () => ++calls === 1
      ? new Response(null, { status: 503, headers: { "Retry-After": retryAfter } }) : reply());
    const pending = extractor.extract(input);
    await advance(1_000);
    expect(await pending).toEqual(parseSlipExtraction(valid));
  });

  it("fails persistent 503 after exactly two attempts and exposes no raw error body or key", async () => {
    const { extractor, fetchMock } = fixture(async () => new Response(PRIVATE, { status: 503 }));
    const pending = extractor.extract(input).catch((error: unknown) => error);
    await advance(1_000);
    const error = await pending;
    expect(error).toBeInstanceOf(ExtractionHttpError);
    expect(error).toMatchObject({ httpStatus: 503, failureCode: "upstream_error", retryable: true, responseSnippet: "", durationMs: 1_000 });
    expect(leaks(error)).not.toContain(PRIVATE);
    expect(leaks(error)).not.toContain(KEY);
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["model JSON", "empty text", "empty envelope", "provider JSON"])("retries malformed/empty %s then succeeds", async (kind) => {
    let calls = 0;
    const { extractor, fetchMock } = fixture(async () => {
      if (++calls > 1) return reply();
      if (kind === "provider JSON") return new Response(`{${PRIVATE}`);
      if (kind === "empty envelope") return new Response(JSON.stringify({ candidates: [{ content: { parts: [null] } }] }));
      return output(kind === "empty text" ? "   " : `{${PRIVATE}`);
    });
    const pending = extractor.extract(input);
    await advance(1_000);
    expect(await pending).toEqual(parseSlipExtraction(valid));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds persistent malformed JSON (one retry) and redacts parser errors", async () => {
    const { extractor, fetchMock } = fixture(async () => output(`{${PRIVATE}`));
    const pending = extractor.extract(input).catch((error: unknown) => error);
    await advance(1_000);
    const error = await pending;
    expect((error as Error).message).toBe("Image extraction provider returned invalid JSON");
    expect(leaks(error)).not.toContain(PRIVATE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds persistent empty output with the no-structured-output error", async () => {
    const { extractor, fetchMock } = fixture(async () => output("  "));
    const pending = extractor.extract(input).catch((error: unknown) => error);
    await advance(1_000);
    expect(((await pending) as Error).message).toBe("Image extraction provider returned no structured output");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [400, "bad_request"], [401, "auth_error"], [403, "auth_error"], [404, "not_found"],
    [413, "payload_too_large"], [501, "upstream_error"],
  ] as const)("fails HTTP %s immediately (%s) without reading a stalled error body", async (status, failureCode) => {
    const json = mock(() => new Promise(() => {}));
    const text = mock(() => new Promise(() => {}));
    const cancel = mock(async () => {});
    const { extractor, fetchMock } = fixture(async () => ({
      ok: false, status, headers: new Headers(), json, text, body: { cancel },
    }) as unknown as Response);
    const error = await extractor.extract(input).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ExtractionHttpError);
    expect(error).toMatchObject({ httpStatus: status, failureCode, retryable: false, responseSnippet: "" });
    expect(leaks(error)).not.toContain(KEY);
    expect(Date.now()).toBe(START);
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, [], "private text", {}, { ...valid, confidence: 2 }, { ...valid, gross_amount: -1 },
    { ...valid, transfer_amount: "100" }, { ...valid, slip_type: PRIVATE },
    { ...valid, receiver_name: 123 }, { ...valid, private_extra: PRIVATE },
  ].map((value) => ({ value })))("rejects invalid extraction schema without retry", async ({ value }) => {
    const { extractor, fetchMock } = fixture(async () => reply(value));
    const error = await extractor.extract(input).catch((error: unknown) => error);
    expect((error as Error).message).toBe("Image extraction provider returned invalid extraction schema");
    expect(leaks(error)).not.toContain(PRIVATE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient network error without retaining its secret message", async () => {
    let calls = 0;
    const { extractor } = fixture(async () => { if (++calls === 1) throw new Error(PRIVATE); return reply(); });
    const pending = extractor.extract(input);
    await advance(1_000);
    expect(await pending).toEqual(parseSlipExtraction(valid));
  });

  it("sanitizes persistent network and body-read errors", async () => {
    for (const bodyFailure of [false, true]) {
      const { extractor, fetchMock } = fixture(async () => {
        if (!bodyFailure) throw new Error(PRIVATE);
        return { ok: true, json: async () => { throw new Error(PRIVATE); } } as unknown as Response;
      });
      const pending = extractor.extract(input).catch((error: unknown) => error);
      await advance(1_000);
      const error = await pending;
      expect(error).toBeInstanceOf(ExtractionHttpError);
      expect(error).toMatchObject({ httpStatus: 0, failureCode: "timeout", responseSnippet: "" });
      expect(leaks(error)).not.toContain(PRIVATE);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("aborts a stalled fetch, retries within the remaining budget, then succeeds", async () => {
    let firstSignal: AbortSignal | null | undefined;
    let calls = 0;
    const { extractor, fetchMock } = fixture(async (_url, init) => {
      if (++calls === 1) { firstSignal = init?.signal; return never(); }
      return reply();
    });
    const pending = extractor.extract(input);
    await advance(15_000);
    expect(firstSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(await pending).toEqual(parseSlipExtraction(valid));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["headers", "body"])("caps persistent %s stalls at 30s, including backoff, with aborted signals", async (stage) => {
    const signals: AbortSignal[] = [];
    const { extractor, fetchMock } = fixture(async (_url, init) => {
      signals.push(init!.signal!);
      return stage === "headers" ? never() : { ok: true, json: never } as unknown as Response;
    });
    const pending = extractor.extract(input).catch((error: unknown) => error);
    let settled = false;
    void pending.then(() => { settled = true; });
    await advance(15_000);
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(13_999);
    expect(settled).toBe(false);
    await advance(1);
    expect(await pending).toMatchObject({ failureCode: "timeout", durationMs: 30_000 });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares the attempt deadline between headers and a stalled body", async () => {
    let signal: AbortSignal | undefined;
    const { extractor, fetchMock } = fixture(async (_url, init) => {
      signal = init!.signal!;
      await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      return { ok: true, json: never } as unknown as Response;
    }, 30_000);
    const pending = extractor.extract(input).catch((error: unknown) => error);
    await advance(10_000);
    await advance(20_000);
    expect(await pending).toMatchObject({ failureCode: "timeout", durationMs: 30_000 });
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([30_000, 60_000, Infinity, NaN])("cannot disable the image cap with call timeout %s", async (timeout) => {
    const { extractor, fetchMock } = fixture(never, timeout);
    const pending = extractor.extract(input).catch((error: unknown) => error);
    if (!Number.isFinite(timeout)) { await advance(15_000); await advance(1_000); await advance(14_000); }
    else await advance(30_000);
    expect(await pending).toMatchObject({ failureCode: "timeout", durationMs: 30_000 });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it.each(["30", "300"])('fails promptly when a 503 Retry-After "%s" cannot fit, with no delayed call', async (retryAfter) => {
    const { extractor, fetchMock } = fixture(async () => new Response(PRIVATE, {
      status: 503, headers: { "Retry-After": retryAfter },
    }));
    const error = await extractor.extract(input).catch((error: unknown) => error);
    expect(error).toMatchObject({ httpStatus: 503, responseSnippet: "" });
    expect(Date.now()).toBe(START);
    await advance(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the remaining budget after a long Retry-After rather than extending the image deadline", async () => {
    let calls = 0;
    const { extractor, fetchMock } = fixture(async () => ++calls === 1
      ? new Response(null, { status: 503, headers: { "Retry-After": "29" } }) : never());
    const pending = extractor.extract(input).catch((error: unknown) => error);
    await advance(29_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(1_000);
    expect(await pending).toMatchObject({ failureCode: "timeout", durationMs: 30_000 });
  });

  it("skips backoff if it would consume all remaining image time", async () => {
    const { extractor, fetchMock } = fixture(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 29_000));
      return new Response(null, { status: 503 });
    }, 30_000);
    const pending = extractor.extract(input).catch((error: unknown) => error);
    await advance(29_000);
    expect(await pending).toMatchObject({ httpStatus: 503, durationMs: 29_000 });
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not consume a late response body or retry after the image timeout", async () => {
    let resolve!: (value: Response) => void;
    const json = mock(async () => valid);
    const cancel = mock(async () => {});
    const { extractor, fetchMock } = fixture(() => new Promise((done) => { resolve = done; }), 30_000);
    const pending = extractor.extract(input).catch((error: unknown) => error);
    await advance(30_000);
    expect(await pending).toMatchObject({ failureCode: "timeout" });
    resolve({ ok: true, json, body: { cancel } } as unknown as Response);
    await advance(60_000);
    expect(json).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry when backoff resumes after the image deadline", async () => {
    const { extractor, fetchMock } = fixture(async () => new Response(null, { status: 503 }));
    const pending = extractor.extract(input).catch((error: unknown) => error);
    await flush();
    // Model an event loop that resumes the backoff timer after the whole budget.
    const clock = jest.spyOn(Date, "now").mockReturnValue(START + 30_000);
    try {
      await advance(1_000);
      expect(await pending).toMatchObject({ failureCode: "timeout", durationMs: 30_000 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("ignores a body that finishes after timeout without scheduling another attempt", async () => {
    let resolveBody!: (value: unknown) => void;
    const { extractor, fetchMock } = fixture(async () => ({
      ok: true, json: () => new Promise((resolve) => { resolveBody = resolve; }),
    }) as unknown as Response, 30_000);
    const pending = extractor.extract(input).catch((error: unknown) => error);
    await advance(30_000);
    expect(await pending).toMatchObject({ failureCode: "timeout" });
    resolveBody({ candidates: [{ content: { parts: [{ text: JSON.stringify(valid) }] } }] });
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a retried wallet image keeps 100 gross / 40 paid after a 503", async () => {
    let calls = 0;
    const { extractor, fetchMock } = fixture(async () => ++calls === 1 ? new Response(null, { status: 503 }) : reply());
    const pending = extractor.extract(input);
    await advance(1_000);
    expect(await pending).toMatchObject({ slipType: "THAI_HELP_THAI", grossAmount: 100, paidAmount: 40 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
