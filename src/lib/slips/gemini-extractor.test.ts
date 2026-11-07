import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { determineSlipCheckStatus, parseSlipExtraction, SLIP_EXTRACTION_JSON_SCHEMA } from "./extraction-schema";
import { ExtractionHttpError, OpenAiSlipExtractor } from "./extractor";
import { DEFAULT_GEMINI_SLIP_MODEL, GeminiSlipExtractor, type GeminiSlipExtractorOptions } from "./gemini-extractor";

// All network access is faked: no real Gemini/OpenAI call is ever made.
const START = Date.UTC(2026, 10, 7);
const PRIVATE = "fixture-key private provider text 123456789";
const KEY = "fixture-key";
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

type Handler = (...args: Parameters<typeof fetch>) => Promise<Response>;

function fixture(handler: Handler, timeout = 15_000, extra: Partial<GeminiSlipExtractorOptions> = {}) {
  const fetchMock = mock(handler);
  const fetchImpl = Object.assign(fetchMock, { preconnect: () => {} }) as unknown as typeof fetch;
  const extractor = new GeminiSlipExtractor({
    apiKey: KEY, model: DEFAULT_GEMINI_SLIP_MODEL, fetchImpl, callTimeoutMs: timeout, ...extra,
  });
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

describe("Gemini bounded, mock-only retries (ported from V1)", () => {
  beforeEach(() => jest.useFakeTimers({ now: START }));
  afterEach(() => {
    const timers = jest.getTimerCount();
    jest.useRealTimers();
    expect(timers).toBe(0);
  });

  it.each([429, 500, 502, 503, 504])("retries HTTP %s once then returns canonical output using the same model/schema", async (status) => {
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
    expect(await pending).toMatchObject({ slipType: "THAI_HELP_THAI", grossAmount: 100, paidAmount: 40, receiverAccountTail: null });
    expect(times).toEqual([0, 1_000]);
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toEndWith("/models/gemini-3.5-flash-lite:generateContent");
    expect(String(url)).not.toContain(KEY);
    expect(init?.body).toBe(fetchMock.mock.calls[0][1]?.body);
    expect(JSON.parse(String(init?.body)).generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: "minimal" }, maxOutputTokens: 2048,
      responseMimeType: "application/json", responseJsonSchema: SLIP_EXTRACTION_JSON_SCHEMA,
    });
  });

  it.each(["3", new Date(START + 3_000).toUTCString()])("honors a fitting 429 Retry-After: %s", async (retryAfter) => {
    let calls = 0;
    const { extractor, fetchMock } = fixture(async () => ++calls === 1
      ? new Response(PRIVATE, { status: 429, headers: { "Retry-After": retryAfter } }) : reply());
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
      ? new Response(null, { status: 429, headers: { "Retry-After": retryAfter } }) : reply());
    const pending = extractor.extract(input);
    await advance(1_000);
    expect(await pending).toEqual(parseSlipExtraction(valid));
  });

  it("fails persistent 503 after exactly two attempts and exposes no raw error body", async () => {
    const { extractor, fetchMock } = fixture(async () => new Response(PRIVATE, { status: 503 }));
    const pending = extractor.extract(input).catch((error: unknown) => error);
    await advance(1_000);
    const error = await pending;
    expect(error).toBeInstanceOf(ExtractionHttpError);
    expect(error).toMatchObject({ httpStatus: 503, retryable: true, responseSnippet: "", durationMs: 1_000 });
    expect(String(error) + JSON.stringify(error)).not.toContain(PRIVATE);
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["model JSON", "empty text", "empty envelope", "provider JSON", "blocked"])("retries malformed/empty/blocked %s once then succeeds", async (kind) => {
    let calls = 0;
    const { extractor, fetchMock } = fixture(async () => {
      if (++calls > 1) return reply();
      if (kind === "provider JSON") return new Response(`{${PRIVATE}`);
      if (kind === "empty envelope") return new Response(JSON.stringify({ candidates: [{ content: { parts: [null] } }] }));
      if (kind === "blocked") return new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" }, candidates: [] }));
      return output(kind === "empty text" ? "   " : `{${PRIVATE}`);
    });
    const pending = extractor.extract(input);
    await advance(1_000);
    expect(await pending).toEqual(parseSlipExtraction(valid));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds persistent malformed JSON and redacts parser errors", async () => {
    const { extractor, fetchMock } = fixture(async () => output(`{${PRIVATE}`));
    const pending = extractor.extract(input).catch((error: unknown) => error);
    await advance(1_000);
    const error = await pending;
    expect(String(error)).toContain("invalid JSON");
    expect(String(error) + JSON.stringify(error)).not.toContain(PRIVATE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds a persistently blocked/empty reply to two attempts", async () => {
    const { extractor, fetchMock } = fixture(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] })));
    const pending = extractor.extract(input).catch((error: unknown) => error);
    await advance(1_000);
    expect(String(await pending)).toContain("no structured output");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 413, 501])("fails HTTP %s immediately without reading a stalled error body", async (status) => {
    const json = mock(() => new Promise(() => {}));
    const text = mock(() => new Promise(() => {}));
    const cancel = mock(async () => {});
    const { extractor, fetchMock } = fixture(async () => ({
      ok: false, status, headers: new Headers(), json, text, body: { cancel },
    }) as unknown as Response);
    const error = await extractor.extract(input).catch((error: unknown) => error);
    expect(error).toMatchObject({ httpStatus: status, retryable: false, responseSnippet: "" });
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
    expect(String(error)).toContain("invalid extraction schema");
    expect(String(error) + JSON.stringify(error)).not.toContain(PRIVATE);
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
      expect(error).toMatchObject({ httpStatus: 0, failureCode: "timeout", responseSnippet: "" });
      expect(String(error) + JSON.stringify(error)).not.toContain(PRIVATE);
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

  it.each(["6", "30", "300"])('fails promptly when Retry-After "%s" exceeds the 5s inline cap, with no delayed call', async (retryAfter) => {
    const { extractor, fetchMock } = fixture(async () => new Response(PRIVATE, {
      status: 429, headers: { "Retry-After": retryAfter },
    }));
    const error = await extractor.extract(input).catch((error: unknown) => error);
    expect(error).toMatchObject({ httpStatus: 429, failureCode: "rate_limit", retryable: true, responseSnippet: "" });
    expect(Date.now()).toBe(START);
    await advance(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('waits a Retry-After of exactly "5" (the cap) and retries', async () => {
    let calls = 0;
    const { extractor, fetchMock } = fixture(async () => ++calls === 1
      ? new Response(null, { status: 429, headers: { "Retry-After": "5" } }) : reply());
    const pending = extractor.extract(input);
    await advance(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(await pending).toEqual(parseSlipExtraction(valid));
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
});

describe("Gemini production contract: permit, key, model", () => {
  const instantSleep = async () => {};
  const envKeys = ["GEMINI_API_KEY", "SLIP_GEMINI_MODEL"] as const;
  let savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
  });
  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("awaits the permit before every attempt: 503 then success = 2 permits, 2 fetches, permit precedes each fetch", async () => {
    const events: string[] = [];
    let calls = 0;
    const sleeps: number[] = [];
    const { extractor, fetchMock } = fixture(async () => {
      events.push("fetch");
      return ++calls === 1 ? new Response(null, { status: 503 }) : reply();
    }, 15_000, {
      acquirePermit: async () => { events.push("permit"); },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(await extractor.extract(input)).toEqual(parseSlipExtraction(valid));
    expect(events).toEqual(["permit", "fetch", "permit", "fetch"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1_000]);
  });

  it("hands the permit the remaining job budget, never more than jobTimeoutMs", async () => {
    const budgets: number[] = [];
    const { extractor } = fixture(async () => reply(), 15_000, {
      jobTimeoutMs: 12_000,
      acquirePermit: async (budgetMs) => { budgets.push(budgetMs); },
    });
    await extractor.extract(input);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toBeGreaterThan(0);
    expect(budgets[0]).toBeLessThanOrEqual(12_000);
  });

  it("persistent 503 consumes exactly maxAttempts permits (default 2)", async () => {
    const permit = mock(async () => {});
    const { extractor, fetchMock } = fixture(async () => new Response(null, { status: 503 }), 15_000,
      { acquirePermit: permit, sleep: instantSleep });
    await expect(extractor.extract(input)).rejects.toMatchObject({ httpStatus: 503 });
    expect(permit).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maxAttempts: 1 makes one permit and one fetch with no retry", async () => {
    const permit = mock(async () => {});
    const { extractor, fetchMock } = fixture(async () => new Response(null, { status: 503 }), 15_000,
      { acquirePermit: permit, sleep: instantSleep, maxAttempts: 1 });
    await expect(extractor.extract(input)).rejects.toMatchObject({ httpStatus: 503 });
    expect(permit).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a non-retryable 400 consumes one permit only", async () => {
    const permit = mock(async () => {});
    const { extractor } = fixture(async () => new Response(null, { status: 400 }), 15_000,
      { acquirePermit: permit, sleep: instantSleep });
    await expect(extractor.extract(input)).rejects.toMatchObject({ httpStatus: 400, retryable: false });
    expect(permit).toHaveBeenCalledTimes(1);
  });

  it("a throwing permit propagates unchanged with zero fetches", async () => {
    const quotaError = new Error("gemini quota exhausted");
    const { extractor, fetchMock } = fixture(async () => reply(), 15_000,
      { acquirePermit: async () => { throw quotaError; }, sleep: instantSleep });
    await expect(extractor.extract(input)).rejects.toBe(quotaError);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("a permit that throws on the retry stops without a second fetch", async () => {
    let permits = 0;
    const quotaError = new Error("gemini quota exhausted");
    const { extractor, fetchMock } = fixture(async () => new Response(null, { status: 503 }), 15_000, {
      acquirePermit: async () => { if (++permits === 2) throw quotaError; },
      sleep: instantSleep,
    });
    await expect(extractor.extract(input)).rejects.toBe(quotaError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("missing key throws before any permit or fetch", async () => {
    const permit = mock(async () => {});
    const { extractor, fetchMock } = fixture(async () => reply(), 15_000, { apiKey: "", acquirePermit: permit });
    await expect(extractor.extract(input)).rejects.toThrow("GEMINI_API_KEY is not configured");
    expect(permit).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(0);

    // Default (env) path with GEMINI_API_KEY unset behaves the same.
    const envPermit = mock(async () => {});
    const envFetch = mock(async () => reply());
    const fromEnv = new GeminiSlipExtractor({ fetchImpl: envFetch as unknown as typeof fetch, acquirePermit: envPermit });
    await expect(fromEnv.extract(input)).rejects.toThrow("GEMINI_API_KEY is not configured");
    expect(envPermit).toHaveBeenCalledTimes(0);
    expect(envFetch).toHaveBeenCalledTimes(0);
  });

  it("sends the key only in x-goog-api-key, never in the URL or body", async () => {
    process.env.GEMINI_API_KEY = "env-secret-key-value";
    const fetchMock = mock<Handler>(async () => reply());
    const extractor = new GeminiSlipExtractor({ fetchImpl: fetchMock as unknown as typeof fetch });
    await extractor.extract(input);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
    expect(String(url)).not.toContain("env-secret-key-value");
    expect(String(url)).not.toContain("key=");
    expect(String(init?.body)).not.toContain("env-secret-key-value");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("env-secret-key-value");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("defaults the model to gemini-3.5-flash-lite, overridable by SLIP_GEMINI_MODEL then options", () => {
    expect(DEFAULT_GEMINI_SLIP_MODEL).toBe("gemini-3.5-flash-lite");
    expect(new GeminiSlipExtractor({ apiKey: KEY }).model).toBe("gemini-3.5-flash-lite");
    process.env.SLIP_GEMINI_MODEL = "gemini-3.6-flash";
    expect(new GeminiSlipExtractor({ apiKey: KEY }).model).toBe("gemini-3.6-flash");
    expect(new GeminiSlipExtractor({ apiKey: KEY, model: "gemini-x" }).model).toBe("gemini-x");
  });
});

describe("Gemini and OpenAI share one canonicalization path", () => {
  function openAiReply(value: unknown): Response {
    return new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }],
    }));
  }

  async function bothProviders(value: unknown) {
    const gemini = new GeminiSlipExtractor({
      apiKey: KEY, fetchImpl: (async () => reply(value)) as unknown as typeof fetch,
    });
    const openai = new OpenAiSlipExtractor(
      "openai-fixture-key", "gpt-6-luna", (async () => openAiReply(value)) as unknown as typeof fetch,
    );
    return { gemini: await gemini.extract(input), openai: await openai.extract(input) };
  }

  // Wallet slip: gross vs discount (subsidy) vs paid (wallet) must come out of
  // parseSlipExtraction identically regardless of provider.
  it.each([
    ["TrueMoney-style wallet with gross/discount/paid", {
      ...valid, slip_type: "GWALLET", payment_channel_text: "TrueMoney Wallet",
      gross_amount: 250, discount_amount: 100, paid_amount: 150,
      project_right_amount: 100, gwallet_amount: 150, headline_total_amount: 250,
      receiver_account_tail: "9876",
    }],
    ["ไทยช่วยไทย headline gross 100 / subsidy 60 / wallet 40 (model gross misread 999)", valid],
    ["wallet with null gross falls back to visible headline", {
      ...valid, slip_type: "GWALLET", payment_channel_text: null, gross_amount: null,
      project_right_amount: 30, gwallet_amount: 20, headline_total_amount: 50,
    }],
    ["bank slip", {
      ...valid, slip_type: "BANK_SLIP_QR", payment_channel_text: null, gross_amount: null,
      project_right_amount: null, gwallet_amount: null, headline_total_amount: null,
      transfer_amount: 315, reference_id: "004999", transaction_time: "06/06/69 08:35",
      receiver_name: "ร้านรับเงิน", receiver_account_tail: "1234",
    }],
  ] as const)("%s", async (_label, value) => {
    const { gemini, openai } = await bothProviders(value);
    expect(gemini).toEqual(openai);
    expect(gemini).toEqual(parseSlipExtraction(value));
    expect(determineSlipCheckStatus(gemini)).toBe(determineSlipCheckStatus(openai));
  });

  it("wallet fields land in gross/discount/paid exactly as the shared parser decides", async () => {
    const { gemini } = await bothProviders(valid);
    expect(gemini).toMatchObject({
      slipType: "THAI_HELP_THAI", grossAmount: 100, discountAmount: 60, paidAmount: 40, receiverAccountTail: null,
    });
    const trueMoney = await bothProviders({
      ...valid, slip_type: "GWALLET", payment_channel_text: "TrueMoney Wallet",
      gross_amount: 250, discount_amount: 100, paid_amount: 150,
      project_right_amount: 100, gwallet_amount: 150, headline_total_amount: 250, receiver_account_tail: "9876",
    });
    expect(trueMoney.gemini).toMatchObject({
      slipType: "GWALLET", grossAmount: 250, discountAmount: 100, paidAmount: 150, receiverAccountTail: null,
    });
  });
});
