import {
  parseSlipExtraction,
  SLIP_EXTRACTION_JSON_SCHEMA,
  type SlipExtraction,
} from "@/lib/slips/extraction-schema";
import { logger } from "@/lib/logger";
import { SLIP_INGEST_POLICY } from "@/lib/slips/ingest-policy";
import { IoTimeoutError, withTimeout } from "@/lib/slips/io-timeout";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-6-luna";
const PROVIDER = "openai";

// Retryable status codes and the delay to wait before the second attempt.
const RETRY_DELAY_MS: Partial<Record<ExtractionFailureCode, number>> = {
  rate_limit:     2000,
  upstream_error: 1000,
  timeout:        1000,
};
const MAX_EXPONENTIAL_RETRY_DELAY_MS = 30_000;
// An OCR job has a 30s hard cap. If Retry-After cannot fit in that job,
// fail visibly rather than leave a detached timer that retries after its lease.
const MAX_INLINE_RETRY_WAIT_MS = 10_000;

export type ExtractionFailureCode =
  | "bad_request"
  | "auth_error"
  | "not_found"
  | "payload_too_large"
  | "rate_limit"
  | "upstream_error"
  | "timeout"
  | "unknown_http_error";

export class ExtractionHttpError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly failureCode: ExtractionFailureCode,
    public readonly retryable: boolean,
    public readonly responseSnippet: string,
    public readonly durationMs: number,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(`Image extraction provider returned HTTP ${httpStatus}`);
    this.name = "ExtractionHttpError";
  }
}

export interface SlipExtractionInput {
  bytes: Uint8Array;
  mimeType: string;
}

export interface SlipExtractor {
  extract(input: SlipExtractionInput): Promise<SlipExtraction>;
}

export class OpenAiSlipExtractor implements SlipExtractor {
  constructor(
    private readonly apiKey = process.env.OPENAI_API_KEY,
    private readonly model = process.env.SLIP_EXTRACTION_MODEL ?? DEFAULT_MODEL,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleepImpl: (ms: number) => Promise<void> = sleep,
    /** Wall-clock cap for ONE provider call, headers and body. */
    private readonly callTimeoutMs: number = SLIP_INGEST_POLICY.io.ocrCallTimeoutMs,
  ) {}

  async extract(input: SlipExtractionInput): Promise<SlipExtraction> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is not configured");

    // One retry for retryable failures (429, 5xx, timeout).
    // Non-retryable failures (400, 401, 403, 404, 413) throw immediately.
    const jobStartedAtMs = Date.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.attemptExtraction(input, attempt);
      } catch (err) {
        if (
          err instanceof ExtractionHttpError &&
          err.retryable &&
          attempt === 1
        ) {
          // Exponential fallback, but never retry before the provider's
          // Retry-After. The whole OCR job is separately hard-capped by the
          // caller, so a very large header cannot hold the cron indefinitely.
          const base = RETRY_DELAY_MS[err.failureCode] ?? 1000;
          const exponential = Math.min(
            base * (2 ** (attempt - 1)),
            MAX_EXPONENTIAL_RETRY_DELAY_MS,
          );
          const delay = Math.max(exponential, err.retryAfterMs ?? 0);
          const fitsJobBudget = Date.now() - jobStartedAtMs + delay + this.callTimeoutMs
            < SLIP_INGEST_POLICY.io.ocrJobTimeoutMs;
          if (delay > MAX_INLINE_RETRY_WAIT_MS || !fitsJobBudget) {
            logger.warn("slip extraction deferred: provider retry delay exceeds OCR job budget", {
              provider: PROVIDER, model: this.model, failureCode: err.failureCode,
              httpStatus: err.httpStatus, retryDelayMs: delay,
            });
            // The caller records a visible failed OCR/check rather than
            // triggering a provider call from a timer after its lease expired.
            throw err;
          }
          logger.warn("slip extraction retrying after transient error", {
            provider:   PROVIDER,
            model:      this.model,
            failureCode: err.failureCode,
            httpStatus: err.httpStatus,
            retryDelayMs: delay,
          });
          await this.sleepImpl(delay);
          continue;
        }
        throw err;
      }
    }

    // Unreachable — loop always throws or returns.
    throw new Error("Extraction loop exited without result");
  }

  private async attemptExtraction(
    input: SlipExtractionInput,
    attempt: number,
  ): Promise<SlipExtraction> {
    const start = Date.now();
    let response: Response;

    try {
      // AbortSignal.timeout also aborts the body read of a real fetch;
      // withTimeout bounds the call even when the transport ignores the signal.
      const callSignal = AbortSignal.timeout(this.callTimeoutMs);
      response = await withTimeout("ocr_http", this.callTimeoutMs, () =>
        this.fetchImpl(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers: {
            // Authorization header is intentionally never logged.
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: buildRequestBody(this.model, input),
          signal: callSignal,
        }),
      );
    } catch (fetchError) {
      const durationMs = Date.now() - start;
      const snippet = fetchError instanceof Error ? fetchError.message.slice(0, 500) : String(fetchError).slice(0, 500);
      logger.warn("slip extraction network error", {
        provider:       PROVIDER,
        model:          this.model,
        failureCode:    "timeout",
        retryable:      true,
        responseSnippet: snippet,
        durationMs,
        imageSizeBytes: input.bytes.length,
        attempt,
      });
      throw new ExtractionHttpError(0, "timeout", true, snippet, durationMs);
    }

    const durationMs = Date.now() - start;

    if (!response.ok) {
      const snippet = await safeReadBody(response);
      const { failureCode, retryable } = classifyHttpStatus(response.status);
      const retryAfterMs = parseProviderRetryAfterMs(response.headers.get("retry-after"));

      logger.warn("slip extraction HTTP error", {
        provider:        PROVIDER,
        model:           this.model,
        httpStatus:      response.status,
        failureCode,
        retryable,
        responseSnippet: snippet,
        durationMs,
        imageSizeBytes:  input.bytes.length,
        attempt,
        retryAfterMs,
      });

      throw new ExtractionHttpError(
        response.status,
        failureCode,
        retryable,
        snippet,
        durationMs,
        retryAfterMs,
      );
    }

    let payload: unknown;
    try {
      payload = await withTimeout("ocr_body", this.callTimeoutMs, () => response.json() as Promise<unknown>);
    } catch (bodyError) {
      if (bodyError instanceof IoTimeoutError) {
        throw new ExtractionHttpError(0, "timeout", true, bodyError.message, Date.now() - start);
      }
      throw bodyError;
    }
    const outputText = readOutputText(payload);
    if (!outputText) throw new Error("Image extraction provider returned no structured output");

    let parsed: unknown;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      throw new Error("Image extraction provider returned invalid JSON");
    }

    return parseSlipExtraction(parsed);
  }
}

export function parseProviderRetryAfterMs(
  value: string | null,
  nowMs = Date.now(),
): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, retryAt - nowMs);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classifyHttpStatus(status: number): {
  failureCode: ExtractionFailureCode;
  retryable: boolean;
} {
  if (status === 400) return { failureCode: "bad_request",       retryable: false };
  if (status === 401 || status === 403) return { failureCode: "auth_error",  retryable: false };
  if (status === 404) return { failureCode: "not_found",         retryable: false };
  if (status === 413) return { failureCode: "payload_too_large", retryable: false };
  if (status === 429) return { failureCode: "rate_limit",        retryable: true  };
  if (status >= 500)  return { failureCode: "upstream_error",    retryable: true  };
  return               { failureCode: "unknown_http_error",      retryable: false };
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return "(body unreadable)";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRequestBody(model: string, input: SlipExtractionInput): string {
  return JSON.stringify({
    model,
    reasoning: model === "gpt-6-luna" ? { effort: "none" } : undefined,
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text: EXTRACTION_PROMPT,
        },
        {
          type:      "input_image",
          // Inline base64 data URI — never logged by this module.
          image_url: `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`,
          detail:    "high",
        },
      ],
    }],
    text: {
      format: {
        type:   "json_schema",
        name:   "slip_extraction",
        strict: true,
        schema: SLIP_EXTRACTION_JSON_SCHEMA,
      },
    },
    max_output_tokens: 1200,
    store: false,
  });
}

export const EXTRACTION_PROMPT = `
Extract only information visibly present in this Thai payment evidence image.
Never infer, calculate, or guess a missing financial value. Return null when unclear.
Classify the image as BANK_SLIP_QR, BANK_SLIP_NO_QR, THAI_HELP_THAI, GWALLET,
NUMBERS_ONLY, WHITE_PAPER, or UNKNOWN.

For transaction_time:
- Copy the visibly written date and time text.
- Do NOT convert Buddhist Era to Gregorian.
- Do NOT guess a missing digit or year.
- Preserve a visible short year such as 69.
- Application code performs calendar normalization.
Use transaction_time only when both date and time are visible.

For THAI_HELP_THAI or GWALLET, copy each labeled number into the matching field:
- project_right_amount: สิทธิโครงการฯ, สิทธิรัฐบาล, or เงินสนับสนุนจากรัฐ.
- gwallet_amount: G-Wallet or ยอด G-Wallet.
- gross_amount: the visible successful receipt / goods-services total
  (รับเงินสำเร็จ, ยอดรับรวม).
- discount_amount must equal project_right_amount.
- paid_amount must equal gwallet_amount.
If all three amounts are visible, use those visible values. Never swap
project_right_amount and gwallet_amount because another interpretation seems
more financially intuitive. Never calculate a missing amount from
gross = subsidy + wallet.

headline_total_amount is the visible top-level successful-receipt / goods-and-
services total shown near the top of the receipt (รับเงินสำเร็จ, ยอดรับรวม,
ยอดรวมการรับเงิน). Transcribe the number exactly as printed. Never compute it
from other amounts, and never invent it when no such line is visible.
This deliberately overlaps with gross_amount above. Production showed the model
returning a null gross_amount while still reading the headline number correctly,
so the two fields are kept separate on purpose — do not merge them back into one.

payment_channel_text is the visible payment-channel or programme line,
transcribed verbatim (for example "ไทยช่วยไทย พลัส (60/40)"). Copy only what is
printed — do not summarize, translate, or interpret it. This field never
determines slip_type on its own; classify slip_type from the overall visible
layout as usual.

For bank slips:
- transfer_amount is the visible transferred amount.

receiver_account_tail is ONLY the last four digits of the receiver, payee, or
merchant account. Digits under รับเงินจาก, ผู้จ่าย, ผู้โอน, sender, or payer
must NOT populate receiver_account_tail; return null instead.

Keep reference_id exactly as shown. If it wraps across lines, join with no
spaces or newlines. Do not return OCR prose or any full bank account number.
`.trim();

function readOutputText(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.output)) return null;

  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
