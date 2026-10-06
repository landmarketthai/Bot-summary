import { describe, expect, it } from "bun:test";
import { OpenAiSlipExtractor, ExtractionHttpError, EXTRACTION_PROMPT } from "@/lib/slips/extractor";

type FetchMockHandler = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

function createFetchMock(handler: FetchMockHandler): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect });
}

describe("OpenAiSlipExtractor", () => {
  it.each(["test-model", "gpt-6-luna"])("%s sends private bytes as an inline image and parses structured output", async (model) => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = createFetchMock(async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        output: [{
          content: [{
            type: "output_text",
            text: JSON.stringify({
              slip_type: "BANK_SLIP_NO_QR",
              gross_amount: null,
              discount_amount: null,
              paid_amount: null,
              transfer_amount: 315,
              reference_id: "004999",
              transaction_time: "2026-06-06T08:35:00+07:00",
              sender_name: null,
              receiver_name: "ร้านรับเงิน",
              receiver_account_tail: "1234",
              confidence: 0.91,
            }),
          }],
        }],
      }), { status: 200 });
    });
    const extractor = new OpenAiSlipExtractor("test-key", model, fetchImpl);

    const result = await extractor.extract({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg",
    });

    expect(result.transferAmount).toBe(315);
    expect(result.transactionTime).toBe("2026-06-06T01:35:00.000Z");
    expect(requests).toHaveLength(1);

    const body = JSON.parse(String(requests[0].init.body)) as {
      model: string;
      reasoning?: { effort: string };
      store: boolean;
      input: Array<{ content: Array<{ type: string; image_url?: string }> }>;
    };
    expect(body.model).toBe(model);
    expect(body.reasoning).toEqual(model === "gpt-6-luna" ? { effort: "none" } : undefined);
    expect(body.store).toBe(false);
    expect(body.input[0].content[1].image_url).toBe("data:image/jpeg;base64,AQID");
  });

  // ── HTTP error classification ─────────────────────────────────────────────

  it("401 throws ExtractionHttpError with failureCode=auth_error and retryable=false", async () => {
    const fetchImpl = createFetchMock(
      async () => new Response("Unauthorized", { status: 401 }),
    );
    const extractor = new OpenAiSlipExtractor("test-key", "test-model", fetchImpl);

    const err = await extractor
      .extract({ bytes: new Uint8Array([1]), mimeType: "image/jpeg" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExtractionHttpError);
    const httpErr = err as ExtractionHttpError;
    expect(httpErr.httpStatus).toBe(401);
    expect(httpErr.failureCode).toBe("auth_error");
    expect(httpErr.retryable).toBe(false);
  });

  it("404 throws ExtractionHttpError with failureCode=not_found and retryable=false", async () => {
    const fetchImpl = createFetchMock(
      async () => new Response("Not Found", { status: 404 }),
    );
    const extractor = new OpenAiSlipExtractor("test-key", "test-model", fetchImpl);

    const err = await extractor
      .extract({ bytes: new Uint8Array([1]), mimeType: "image/jpeg" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExtractionHttpError);
    const httpErr = err as ExtractionHttpError;
    expect(httpErr.httpStatus).toBe(404);
    expect(httpErr.failureCode).toBe("not_found");
    expect(httpErr.retryable).toBe(false);
  });

  // ── Retry behaviour ───────────────────────────────────────────────────────

  it("429 retries exactly once and succeeds on second attempt", async () => {
    let callCount = 0;
    const fetchImpl = createFetchMock(async () => {
      callCount += 1;
      if (callCount === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: JSON.stringify({
          slip_type: "BANK_SLIP_NO_QR",
          gross_amount: null, discount_amount: null, paid_amount: null,
          transfer_amount: 100, reference_id: "REF1",
          transaction_time: "2026-06-10T08:00:00+07:00",
          sender_name: null, receiver_name: null, receiver_account_tail: null,
          confidence: 0.9,
        }) }] }],
      }), { status: 200 });
    });
    const noopSleep = () => Promise.resolve();
    const extractor = new OpenAiSlipExtractor("test-key", "test-model", fetchImpl, noopSleep);

    const result = await extractor.extract({ bytes: new Uint8Array([1]), mimeType: "image/jpeg" });

    expect(callCount).toBe(2);
    expect(result.transferAmount).toBe(100);
  });

  it("500 retries exactly once and throws on second 500", async () => {
    let callCount = 0;
    const fetchImpl = createFetchMock(async () => {
      callCount += 1;
      return new Response("internal error", { status: 500 });
    });
    const noopSleep = () => Promise.resolve();
    const extractor = new OpenAiSlipExtractor("test-key", "test-model", fetchImpl, noopSleep);

    const err = await extractor
      .extract({ bytes: new Uint8Array([1]), mimeType: "image/jpeg" })
      .catch((e: unknown) => e);

    expect(callCount).toBe(2);
    expect(err).toBeInstanceOf(ExtractionHttpError);
    expect((err as ExtractionHttpError).failureCode).toBe("upstream_error");
  });

  it("400 does not retry — throws immediately after one attempt", async () => {
    let callCount = 0;
    const fetchImpl = createFetchMock(async () => {
      callCount += 1;
      return new Response("bad request", { status: 400 });
    });
    const extractor = new OpenAiSlipExtractor("test-key", "test-model", fetchImpl);

    const err = await extractor
      .extract({ bytes: new Uint8Array([1]), mimeType: "image/jpeg" })
      .catch((e: unknown) => e);

    expect(callCount).toBe(1);
    expect(err).toBeInstanceOf(ExtractionHttpError);
    expect((err as ExtractionHttpError).failureCode).toBe("bad_request");
    expect((err as ExtractionHttpError).retryable).toBe(false);
  });

  // ── Secret safety ─────────────────────────────────────────────────────────

  it("ExtractionHttpError fields do not contain the API key or auth header value", async () => {
    const secretKey = "sk-super-secret-key-do-not-log";
    const fetchImpl = createFetchMock(
      async () => new Response(`{"error":"invalid key"}`, { status: 401 }),
    );
    const extractor = new OpenAiSlipExtractor(secretKey, "test-model", fetchImpl);

    const err = await extractor
      .extract({ bytes: new Uint8Array([1]), mimeType: "image/jpeg" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExtractionHttpError);
    const httpErr = err as ExtractionHttpError;

    // None of the publicly exposed fields on the error should contain the secret.
    expect(httpErr.message).not.toContain(secretKey);
    expect(httpErr.responseSnippet).not.toContain(secretKey);
    expect(httpErr.failureCode).not.toContain(secretKey);

    // The responseSnippet is the body the *provider* returned — capped at 500 chars.
    expect(httpErr.responseSnippet).toBe('{"error":"invalid key"}');
    expect(httpErr.responseSnippet.length).toBeLessThanOrEqual(500);
  });

  it("prompt keeps calendar conversion and Thai Help Thai labels out of model arithmetic", () => {
    expect(EXTRACTION_PROMPT).not.toMatch(/Convert a visible Thai Buddhist year/i);
    expect(EXTRACTION_PROMPT).toMatch(/Do NOT convert Buddhist Era to Gregorian/);
    expect(EXTRACTION_PROMPT).toMatch(/Preserve a visible short year such as 69/);
    expect(EXTRACTION_PROMPT).toMatch(/project_right_amount: สิทธิโครงการฯ/);
    expect(EXTRACTION_PROMPT).toMatch(/gwallet_amount: G-Wallet/);
    expect(EXTRACTION_PROMPT).toMatch(/discount_amount must equal project_right_amount/);
    expect(EXTRACTION_PROMPT).toMatch(/paid_amount must equal gwallet_amount/);
    expect(EXTRACTION_PROMPT).toMatch(/Never calculate/);
    expect(EXTRACTION_PROMPT).toMatch(/รับเงินจาก/);
    expect(EXTRACTION_PROMPT).toMatch(/must NOT populate receiver_account_tail/);
    expect(EXTRACTION_PROMPT).toMatch(/join with no\s+spaces or newlines/);
  });
});
