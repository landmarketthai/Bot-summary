import {
  parseSettlementSheetExtraction,
  SETTLEMENT_SHEET_EXTRACTION_JSON_SCHEMA,
} from "@/lib/settlement-ocr/extraction-schema";
import type {
  SettlementSheetExtraction,
  SettlementSheetExtractionInput,
  SettlementSheetExtractor,
} from "@/lib/settlement-ocr/types";
import { logger } from "@/lib/logger";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4o-mini";
const PROVIDER = "openai";

type FailureCode =
  | "bad_request" | "auth_error" | "not_found" | "payload_too_large"
  | "rate_limit" | "upstream_error" | "timeout" | "unknown_http_error";

const RETRY_DELAY_MS: Partial<Record<FailureCode, number>> = {
  rate_limit: 2000,
  upstream_error: 1000,
  timeout: 1000,
};

export class SettlementSheetExtractionHttpError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly failureCode: FailureCode,
    public readonly retryable: boolean,
    public readonly responseSnippet: string,
    public readonly durationMs: number,
  ) {
    super(`Settlement sheet extraction provider returned HTTP ${httpStatus}`);
    this.name = "SettlementSheetExtractionHttpError";
  }
}

/**
 * The prompt deliberately never asks the model to compute or guess a
 * missing amount, never asks it to convert the B.E. date (application code
 * does that — see extraction-schema.ts's parseSettlementSheetDate), and
 * explicitly classifies document_type so a non-settlement-sheet photo (an
 * ordinary photo, a produce photo, a bank slip) is reported as OTHER rather
 * than forced into a settlement reading.
 */
export const SETTLEMENT_SHEET_EXTRACTION_PROMPT = `
You are reading a photo that MAY be a handwritten Thai daily market
settlement sheet (a fixed paper form with printed Thai field labels and
hand-filled numbers). It is NOT a bank transfer slip, receipt, or QR code
payment screenshot — those look different and must be classified OTHER here.

First classify document_type:
- SETTLEMENT_SHEET: a paper form with (some of) these printed Thai labels,
  each followed by a handwritten number: ตลาด, วันที่, คนขาย, ยอดขาย, เงินโอน,
  ค่าใช้จ่าย, ส่งเงินสด, ค่าแรง, เหลือเงินสด, and usually two signature lines
  at the bottom.
- OTHER: anything else — a bank slip, a produce/product photo, a person, a
  screenshot, or a page too unclear to identify a settlement-sheet layout.
Set document_type_confidence honestly; when unsure, prefer OTHER with low
confidence rather than guessing SETTLEMENT_SHEET.

Never infer, calculate, or guess a missing or illegible number. Leave a
money field's value null when you cannot read it. If a number is crossed
out and rewritten, read the FINAL (rewritten, not crossed-out) value only;
if you cannot tell which is final, leave the value null and lower its
confidence.

For each money field, "confidence" must reflect only how legible/certain
YOUR reading of that specific handwritten number is (not overall image
quality) — 1.0 for clearly written digits, lower for smudged, ambiguous, or
partially obscured digits.

Field mapping (printed Thai label -> field):
  ตลาด                      -> market_text (verbatim text, not a money field)
  วันที่                     -> date_text (verbatim, e.g. "21/9/69" — do NOT
                                convert Buddhist Era to Gregorian)
  คนขาย                     -> staff_text (verbatim text)
  ยอดขาย                    -> sales_total
  เงินโอน                    -> transfer_amount
  ค่าใช้จ่าย                  -> expenses_total, PLUS each individual
                                handwritten expense note/amount under it as
                                one entry in expense_items (label = the
                                handwritten note if any, else null)
  ส่งเงินสด                  -> cash_submitted
  ค่าแรง                     -> labor_total, PLUS each individual handwritten
                                labor note/person/amount under it as one
                                entry in labor_items
  เหลือเงินสด                -> cash_remaining

Never identify or name people from signatures. Do not transcribe signature
strokes into any field.
`.trim();

export class OpenAiSettlementSheetExtractor implements SettlementSheetExtractor {
  constructor(
    private readonly apiKey = process.env.OPENAI_API_KEY,
    private readonly model = process.env.SETTLEMENT_SHEET_EXTRACTION_MODEL ?? DEFAULT_MODEL,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleepImpl: (ms: number) => Promise<void> = sleep,
  ) {}

  async extract(input: SettlementSheetExtractionInput): Promise<SettlementSheetExtraction> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is not configured");

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.attemptExtraction(input, attempt);
      } catch (err) {
        if (
          err instanceof SettlementSheetExtractionHttpError
          && err.retryable
          && attempt === 1
        ) {
          const delay = RETRY_DELAY_MS[err.failureCode] ?? 1000;
          logger.warn("settlement sheet extraction retrying after transient error", {
            provider: PROVIDER,
            model: this.model,
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

    throw new Error("Extraction loop exited without result");
  }

  private async attemptExtraction(
    input: SettlementSheetExtractionInput,
    attempt: number,
  ): Promise<SettlementSheetExtraction> {
    const start = Date.now();
    let response: Response;

    try {
      response = await this.fetchImpl(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: buildRequestBody(this.model, input),
      });
    } catch (fetchError) {
      const durationMs = Date.now() - start;
      const snippet = fetchError instanceof Error
        ? fetchError.message.slice(0, 500)
        : String(fetchError).slice(0, 500);
      logger.warn("settlement sheet extraction network error", {
        provider: PROVIDER,
        model: this.model,
        failureCode: "timeout",
        retryable: true,
        responseSnippet: snippet,
        durationMs,
        imageSizeBytes: input.bytes.length,
        attempt,
      });
      throw new SettlementSheetExtractionHttpError(0, "timeout", true, snippet, durationMs);
    }

    const durationMs = Date.now() - start;

    if (!response.ok) {
      const snippet = await safeReadBody(response);
      const { failureCode, retryable } = classifyHttpStatus(response.status);
      logger.warn("settlement sheet extraction HTTP error", {
        provider: PROVIDER,
        model: this.model,
        httpStatus: response.status,
        failureCode,
        retryable,
        responseSnippet: snippet,
        durationMs,
        imageSizeBytes: input.bytes.length,
        attempt,
      });
      throw new SettlementSheetExtractionHttpError(
        response.status,
        failureCode,
        retryable,
        snippet,
        durationMs,
      );
    }

    const payload = await response.json() as unknown;
    const outputText = readOutputText(payload);
    if (!outputText) throw new Error("Settlement sheet extraction provider returned no structured output");

    let parsed: unknown;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      throw new Error("Settlement sheet extraction provider returned invalid JSON");
    }

    return parseSettlementSheetExtraction(parsed);
  }
}

function classifyHttpStatus(status: number): { failureCode: FailureCode; retryable: boolean } {
  if (status === 400) return { failureCode: "bad_request", retryable: false };
  if (status === 401 || status === 403) return { failureCode: "auth_error", retryable: false };
  if (status === 404) return { failureCode: "not_found", retryable: false };
  if (status === 413) return { failureCode: "payload_too_large", retryable: false };
  if (status === 429) return { failureCode: "rate_limit", retryable: true };
  if (status >= 500) return { failureCode: "upstream_error", retryable: true };
  return { failureCode: "unknown_http_error", retryable: false };
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "(body unreadable)";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRequestBody(model: string, input: SettlementSheetExtractionInput): string {
  return JSON.stringify({
    model,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: SETTLEMENT_SHEET_EXTRACTION_PROMPT },
        {
          type: "input_image",
          image_url: `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`,
          detail: "high",
        },
      ],
    }],
    text: {
      format: {
        type: "json_schema",
        name: "settlement_sheet_extraction",
        strict: true,
        schema: SETTLEMENT_SHEET_EXTRACTION_JSON_SCHEMA,
      },
    },
    max_output_tokens: 1500,
    store: false,
  });
}

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
