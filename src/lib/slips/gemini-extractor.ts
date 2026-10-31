import {
  parseSlipExtraction,
  SLIP_EXTRACTION_JSON_SCHEMA,
  type SlipExtraction,
} from "@/lib/slips/extraction-schema";
import {
  EXTRACTION_PROMPT,
  ExtractionHttpError,
  type SlipExtractionInput,
  type SlipExtractor,
} from "@/lib/slips/extractor";
import { SLIP_INGEST_POLICY } from "@/lib/slips/ingest-policy";
import { withTimeout } from "@/lib/slips/io-timeout";

/**
 * EVALUATION-ONLY Gemini adapter. Not wired into CheckService: Production OCR
 * stays on OpenAiSlipExtractor / CascadingSlipExtractor. It sends the same
 * prompt and the same JSON schema, and its output goes through the same
 * parseSlipExtraction canonicalization, so a comparison measures the model and
 * nothing else.
 *
 * ponytail: single attempt, no retry/backoff. Add the OpenAiSlipExtractor
 * retry policy before this ever serves Production traffic.
 */
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
export const DEFAULT_GEMINI_SLIP_MODEL = "gemini-3.8-flash";

export class GeminiSlipExtractor implements SlipExtractor {
  constructor(
    private readonly apiKey = process.env.GEMINI_API_KEY,
    readonly model = process.env.SLIP_EVAL_GEMINI_MODEL ?? DEFAULT_GEMINI_SLIP_MODEL,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly callTimeoutMs: number = SLIP_INGEST_POLICY.io.ocrCallTimeoutMs,
  ) {}

  async extract(input: SlipExtractionInput): Promise<SlipExtraction> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not configured");
    const start = Date.now();
    let response: Response;
    try {
      response = await withTimeout("ocr_http", this.callTimeoutMs, () =>
        this.fetchImpl(`${GEMINI_URL}/${encodeURIComponent(this.model)}:generateContent`, {
          method: "POST",
          // The key travels only in this header and is never logged.
          headers: { "x-goog-api-key": this.apiKey!, "Content-Type": "application/json" },
          body: buildGeminiRequestBody(input),
          signal: AbortSignal.timeout(this.callTimeoutMs),
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 200) : "network error";
      throw new ExtractionHttpError(0, "timeout", true, message, Date.now() - start);
    }
    if (!response.ok) {
      const status = response.status;
      const retryable = status === 429 || status >= 500;
      throw new ExtractionHttpError(
        status,
        status === 429 ? "rate_limit" : status >= 500 ? "upstream_error" : "bad_request",
        retryable,
        (await response.text().catch(() => "")).slice(0, 300),
        Date.now() - start,
      );
    }
    const text = readGeminiOutputText(await response.json());
    if (!text) throw new Error("Image extraction provider returned no structured output");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Image extraction provider returned invalid JSON");
    }
    return parseSlipExtraction(parsed);
  }
}

export function buildGeminiRequestBody(input: SlipExtractionInput): string {
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
      maxOutputTokens: 1200,
      responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: SLIP_EXTRACTION_JSON_SCHEMA } },
    },
  });
}

export function readGeminiOutputText(payload: unknown): string | null {
  const parts = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; thought?: unknown }> } }> })
    ?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
  return text || null;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Billable token usage from a raw provider reply (thinking tokens bill as output). */
export function readProviderUsage(provider: "openai" | "gemini", payload: unknown): ProviderUsage | null {
  const p = payload as Record<string, Record<string, number> | undefined>;
  if (provider === "openai") {
    const u = p?.usage;
    return u ? { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 } : null;
  }
  const u = p?.usageMetadata;
  return u
    ? { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) }
    : null;
}
