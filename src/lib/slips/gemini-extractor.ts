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
 * Gemini slip OCR adapter. Wired into Production only behind
 * SLIP_GEMINI_OCR_ENABLED via production-extractor.ts; with the flag off the
 * legacy OCR path is unchanged. It sends the same prompt and JSON schema as the
 * OpenAI extractor, and its output goes through the same parseSlipExtraction
 * canonicalization.
 *
 * Output is TRANSCRIPTION ONLY: what the image visibly says. It is never bank
 * verification — no amount or reference read here proves a transfer happened.
 */
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
export const DEFAULT_GEMINI_SLIP_MODEL = "gemini-3.5-flash-lite";
const IMAGE_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 2;
const MAX_BACKOFF_MS = 2_000;
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
// Free-tier quota is 15 RPM / 500 RPD per project and there is no shared
// cross-instance rate gate, so a 429 is never retried here: it is thrown at once
// (still retryable=true) so the caller falls back to legacy OCR instead of
// spending more of the same exhausted quota.
const NO_INLINE_RETRY_HTTP_STATUSES = new Set([429]);

class RetryableGeminiOutputError extends Error {}

export class GeminiSlipExtractor implements SlipExtractor {
  constructor(
    private readonly apiKey = process.env.GEMINI_API_KEY,
    readonly model = process.env.SLIP_GEMINI_MODEL ?? DEFAULT_GEMINI_SLIP_MODEL,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly callTimeoutMs: number = SLIP_INGEST_POLICY.io.ocrCallTimeoutMs,
  ) {}

  async extract(input: SlipExtractionInput): Promise<SlipExtraction> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not configured");
    const start = Date.now();
    const deadline = start + IMAGE_TIMEOUT_MS;
    const body = buildGeminiRequestBody(input, this.model);
    const callTimeoutMs = Number.isFinite(this.callTimeoutMs)
      ? Math.max(1, Math.floor(this.callTimeoutMs))
      : SLIP_INGEST_POLICY.io.ocrCallTimeoutMs;
    const timeoutError = () => new ExtractionHttpError(0, "timeout", true, "", Date.now() - start);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutError();
      const attemptTimeoutMs = Math.min(callTimeoutMs, remaining);
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
            response = await this.fetchImpl(`${GEMINI_URL}/${encodeURIComponent(this.model)}:generateContent`, {
              method: "POST",
              // The key travels only in this header and is never logged.
              headers: { "x-goog-api-key": this.apiKey!, "Content-Type": "application/json" },
              body,
              signal,
            });
          } catch {
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
                  : status === 404 ? "not_found" : status === 413 ? "payload_too_large" : "bad_request",
              RETRYABLE_HTTP_STATUSES.has(status),
              "",
              Date.now() - start,
              parseProviderRetryAfterMs(response.headers.get("retry-after")),
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
          || (failure instanceof ExtractionHttpError && failure.retryable
            && !NO_INLINE_RETRY_HTTP_STATUSES.has(failure.httpStatus));
        if (!retryable || attempt === MAX_ATTEMPTS) throw failure;
        const backoff = Math.min(1_000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        const delay = Math.max(backoff, failure instanceof ExtractionHttpError ? failure.retryAfterMs ?? 0 : 0);
        // Do not shorten Retry-After or schedule a call after the image's deadline.
        if (delay >= deadline - Date.now()) throw failure;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
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
  // Gemini 3.5/3.6 models (incl. gemini-3.5-flash-lite) may default to more
  // thinking, which can exhaust a tight output cap before the required JSON is
  // completed. Minimal is valid for 3.5/3.6.
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
      responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: SLIP_EXTRACTION_JSON_SCHEMA } },
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
