import {
  parseSlipExtraction,
  SLIP_EXTRACTION_JSON_SCHEMA,
  type SlipExtraction,
} from "@/lib/slips/extraction-schema";
import {
  EXTRACTION_PROMPT,
  ExtractionHttpError,
  parseProviderRetryAfterMs,
  type SlipExtractionInput,
  type SlipExtractor,
} from "@/lib/slips/extractor";
import { SLIP_INGEST_POLICY } from "@/lib/slips/ingest-policy";
import { IoTimeoutError, withTimeout } from "@/lib/slips/io-timeout";

/**
 * Gemini slip OCR adapter. Used only when EasySlip did not bank-verify the
 * image; its output is a transcription, NEVER bank verification.
 *
 * It sends the same prompt and JSON schema as OpenAiSlipExtractor, and its
 * output goes through the same parseSlipExtraction canonicalization, so wallet
 * gross/paid selection and status logic are identical across providers.
 *
 * Quota: every HTTP attempt (including retries) counts against the shared
 * Gemini RPM/RPD limits, so `acquirePermit` is awaited before EVERY attempt
 * and retries are kept small. The default no-op permit is for tests/eval only;
 * production wiring must pass the shared limiter's permit.
 */
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
export const DEFAULT_GEMINI_SLIP_MODEL = "gemini-3.5-flash-lite";
/** Whole-image wall-clock cap (all attempts and backoff). */
const IMAGE_TIMEOUT_MS = SLIP_INGEST_POLICY.io.ocrJobTimeoutMs;
const DEFAULT_MAX_ATTEMPTS = 2;
/** Hard ceiling: each attempt burns shared free-tier quota. */
const MAX_ATTEMPTS_CEILING = 3;
const MAX_BACKOFF_MS = 2_000;
/**
 * Longest inline wait before a retry. A longer Retry-After is respected by NOT
 * retrying (fail now, let the caller fall back) rather than shortening it or
 * holding the OCR lane/lease.
 */
export const MAX_GEMINI_RETRY_DELAY_MS = 5_000;
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

class RetryableGeminiOutputError extends Error {}

export interface GeminiSlipExtractorOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Awaited before every HTTP attempt with the job time left; a permit must
   * not wait longer than that. A throw propagates without fetching. */
  acquirePermit?: (budgetMs: number) => Promise<void>;
  /** Cap for the whole image (permit waits + all attempts). Default ocrJobTimeoutMs. */
  jobTimeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Cap for ONE provider call (headers and body). Never exceeds the image cap. */
  callTimeoutMs?: number;
}

const noPermit = async () => {};
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GeminiSlipExtractor implements SlipExtractor {
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly acquirePermit: (budgetMs: number) => Promise<void>;
  private readonly jobTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly callTimeoutMs: number;

  constructor(options: GeminiSlipExtractorOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    this.model = options.model ?? process.env.SLIP_GEMINI_MODEL ?? DEFAULT_GEMINI_SLIP_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.acquirePermit = options.acquirePermit ?? noPermit;
    const jobTimeoutMs = options.jobTimeoutMs ?? IMAGE_TIMEOUT_MS;
    this.jobTimeoutMs = Number.isFinite(jobTimeoutMs)
      ? Math.min(Math.max(1, Math.floor(jobTimeoutMs)), IMAGE_TIMEOUT_MS)
      : IMAGE_TIMEOUT_MS;
    const attempts = Number.isFinite(options.maxAttempts) ? Math.floor(options.maxAttempts!) : DEFAULT_MAX_ATTEMPTS;
    this.maxAttempts = Math.min(Math.max(1, attempts), MAX_ATTEMPTS_CEILING);
    this.sleep = options.sleep ?? defaultSleep;
    const callTimeoutMs = options.callTimeoutMs ?? SLIP_INGEST_POLICY.io.ocrCallTimeoutMs;
    this.callTimeoutMs = Number.isFinite(callTimeoutMs)
      ? Math.max(1, Math.floor(callTimeoutMs))
      : SLIP_INGEST_POLICY.io.ocrCallTimeoutMs;
  }

  async extract(input: SlipExtractionInput): Promise<SlipExtraction> {
    // Before any permit or network call: a missing key must not burn quota.
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not configured");
    const apiKey = this.apiKey;
    const start = Date.now();
    const deadline = start + this.jobTimeoutMs;
    const body = buildGeminiRequestBody(input, this.model);
    const url = `${GEMINI_URL}/${encodeURIComponent(this.model)}:generateContent`;
    const timeoutError = () => new ExtractionHttpError(0, "timeout", true, "", Date.now() - start);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (deadline - Date.now() <= 0) throw timeoutError();
      // Every attempt is a billable/quota request. A permit failure (quota
      // exhausted, limiter unavailable) propagates as-is: no fetch, no retry.
      await this.acquirePermit(deadline - Date.now());
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutError();
      const attemptTimeoutMs = Math.min(this.callTimeoutMs, remaining);
      const attemptDeadline = Date.now() + attemptTimeoutMs;
      try {
        // One bound covers headers AND body, even if the transport ignores abort.
        return await withTimeout("gemini_ocr", attemptTimeoutMs, async (signal) => {
          const checkDeadline = () => {
            signal.throwIfAborted();
            if (Date.now() >= Math.min(deadline, attemptDeadline)) throw timeoutError();
          };
          checkDeadline();
          let response: Response;
          try {
            response = await this.fetchImpl(url, {
              method: "POST",
              // The key travels only in this header; never in the URL or logs.
              headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
              body,
              signal,
            });
          } catch {
            // Network errors may echo request details; keep none of them.
            throw timeoutError();
          }
          // Never read or retain a provider error body: it may hang or contain secrets.
          if (!response.ok || signal.aborted) void response.body?.cancel().catch(() => {});
          checkDeadline();
          if (!response.ok) {
            const status = response.status;
            throw new ExtractionHttpError(
              status,
              status === 429 ? "rate_limit" : status >= 500 ? "upstream_error"
                : status === 401 || status === 403 ? "auth_error"
                  : status === 404 ? "not_found" : status === 413 ? "payload_too_large"
                    : status === 400 ? "bad_request" : "unknown_http_error",
              RETRYABLE_HTTP_STATUSES.has(status),
              "",
              Date.now() - start,
              parseProviderRetryAfterMs(response.headers?.get("retry-after") ?? null),
            );
          }
          let payload: unknown;
          try {
            payload = await response.json();
          } catch (error) {
            if (error instanceof SyntaxError) {
              throw new RetryableGeminiOutputError("Image extraction provider returned invalid JSON");
            }
            throw timeoutError();
          }
          checkDeadline();
          // Blocked/empty candidates (safety, recitation, max tokens) land here.
          const text = readGeminiOutputText(payload);
          if (!text?.trim()) {
            throw new RetryableGeminiOutputError("Image extraction provider returned no structured output");
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new RetryableGeminiOutputError("Image extraction provider returned invalid JSON");
          }
          // Validate only this adapter's wire format; keep shared canonicalization unchanged.
          validateGeminiExtraction(parsed);
          const extraction = parseSlipExtraction(parsed);
          checkDeadline();
          return extraction;
        });
      } catch (error) {
        const failure = error instanceof IoTimeoutError ? timeoutError() : error;
        const retryable = failure instanceof RetryableGeminiOutputError
          || (failure instanceof ExtractionHttpError && failure.retryable);
        if (!retryable || attempt >= this.maxAttempts) throw failure;
        const backoff = Math.min(1_000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        const delay = Math.max(backoff, failure instanceof ExtractionHttpError ? failure.retryAfterMs ?? 0 : 0);
        // Never shorten Retry-After, never hold the lane long, never retry past the image deadline.
        if (delay > MAX_GEMINI_RETRY_DELAY_MS || delay >= deadline - Date.now()) throw failure;
        await this.sleep(delay);
      }
    }
    throw timeoutError();
  }
}

function validateGeminiExtraction(value: unknown): void {
  const invalid = () => { throw new Error("Image extraction provider returned invalid extraction schema"); };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  const schema = SLIP_EXTRACTION_JSON_SCHEMA;
  if (Object.keys(record).some((key) => !Object.hasOwn(schema.properties, key))) return invalid();
  for (const key of schema.required) {
    const field = record[key];
    const rule = schema.properties[key];
    const types: readonly string[] = typeof rule.type === "string" ? [rule.type] : rule.type;
    if (!Object.hasOwn(record, key) || !types.includes(field === null ? "null" : typeof field)) return invalid();
    if ("enum" in rule && !(rule.enum as readonly unknown[]).includes(field)) return invalid();
    if (typeof field === "number" && (!Number.isFinite(field)
      || ("minimum" in rule && field < rule.minimum)
      || ("maximum" in rule && field > rule.maximum))) return invalid();
  }
}

export function buildGeminiRequestBody(input: SlipExtractionInput, model = DEFAULT_GEMINI_SLIP_MODEL): string {
  // Gemini 3.5/3.6 default thinking can exhaust a tight output cap before the
  // required JSON is completed; "minimal" is valid for these families.
  const supportsMinimalThinking = /^gemini-3\.(?:5|6)-/.test(model);
  return JSON.stringify({
    contents: [{
      role: "user",
      parts: [
        { text: EXTRACTION_PROMPT },
        { inlineData: { mimeType: input.mimeType, data: Buffer.from(input.bytes).toString("base64") } },
      ],
    }],
    generationConfig: {
      // Same detail level as the OpenAI request (detail: "high").
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
      ...(supportsMinimalThinking ? { thinkingConfig: { thinkingLevel: "minimal" } } : {}),
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
      responseJsonSchema: SLIP_EXTRACTION_JSON_SCHEMA,
    },
  });
}

export function readGeminiOutputText(payload: unknown): string | null {
  const parts = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; thought?: unknown }> } }> })
    ?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.filter((p) => typeof p?.text === "string" && !p.thought).map((p) => p.text).join("");
  return text || null;
}
