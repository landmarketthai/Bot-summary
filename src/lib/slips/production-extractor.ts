import type { SlipExtraction } from "@/lib/slips/extraction-schema";
import {
  ExtractionHttpError,
  type SlipExtractionInput,
  type SlipExtractor,
} from "@/lib/slips/extractor";
import { CascadingSlipExtractor } from "@/lib/slips/cascade-extractor";
import { DEFAULT_GEMINI_SLIP_MODEL, GeminiSlipExtractor } from "@/lib/slips/gemini-extractor";
import { logger } from "@/lib/logger";

/** Env kill switch. Only the exact value "true" (trimmed) enables Gemini-first
 * OCR; unset or anything else keeps the legacy OpenAI OCR path. */
export const SLIP_GEMINI_OCR_ENABLED_ENV = "SLIP_GEMINI_OCR_ENABLED";
/** Leave enough of the existing 30s OCR redrive job budget for legacy fallback. */
export const PRODUCTION_GEMINI_CALL_TIMEOUT_MS = 5_000;

type Env = Record<string, string | undefined>;

export function isGeminiSlipOcrEnabled(env: Env = process.env): boolean {
  return env[SLIP_GEMINI_OCR_ENABLED_ENV]?.trim() === "true";
}

// Error messages known to carry no secrets or provider bodies. Anything else
// is logged as "unknown" so raw provider text never reaches the logs.
const SAFE_FAILURE_REASONS: Record<string, string> = {
  "GEMINI_API_KEY is not configured": "not_configured",
  "Image extraction provider returned no structured output": "empty_output",
  "Image extraction provider returned invalid JSON": "invalid_output",
  "Image extraction provider returned invalid extraction schema": "invalid_output",
  "Extractor returned a non-object result": "invalid_output",
};

function safeFailureContext(error: unknown): Record<string, unknown> {
  if (error instanceof ExtractionHttpError) {
    return {
      provider: "gemini",
      httpStatus: error.httpStatus,
      failureCode: error.failureCode,
      retryable: error.retryable,
    };
  }
  const message = error instanceof Error ? error.message : "";
  return { provider: "gemini", reason: SAFE_FAILURE_REASONS[message] ?? "unknown" };
}

/** Distinguish readable amount from incomplete metadata: dates/refs are not
 * required for a provisional amount. Never retry ordinary non-slip images. */
function hasReadableAmount(extraction: SlipExtraction): boolean {
  const amount = extraction.slipType === "BANK_SLIP_QR" || extraction.slipType === "BANK_SLIP_NO_QR"
    ? extraction.transferAmount
    : extraction.slipType === "GWALLET" || extraction.slipType === "THAI_HELP_THAI"
      ? extraction.headlineTotalAmount ?? extraction.grossAmount
      : null;
  return amount !== null && typeof amount === "number" && Number.isFinite(amount) && amount >= 0;
}

function isRecognizedPayment(extraction: SlipExtraction): boolean {
  return extraction.slipType === "BANK_SLIP_QR" || extraction.slipType === "BANK_SLIP_NO_QR"
    || extraction.slipType === "GWALLET" || extraction.slipType === "THAI_HELP_THAI";
}

/** Gemini primary, legacy OCR fallback. Exactly one result is returned per
 * extract(): the primary is tried once, and on provider failure or missing
 * amount the fallback is called once. Fallback errors propagate unchanged. */
export class GeminiFirstSlipExtractor implements SlipExtractor {
  constructor(
    private readonly primary: SlipExtractor,
    private readonly fallback: SlipExtractor,
  ) {}

  async extract(input: SlipExtractionInput): Promise<SlipExtraction> {
    let result: SlipExtraction;
    try {
      result = await this.primary.extract(input);
    } catch (error) {
      logger.warn("slip Gemini OCR failed - using legacy OCR", safeFailureContext(error));
      return this.fallback.extract(input);
    }
    if (isRecognizedPayment(result) && !hasReadableAmount(result)) {
      logger.warn("slip Gemini OCR missing visible payment amount - using legacy OCR", {
        provider: "gemini", reason: "missing_amount",
      });
      return this.fallback.extract(input);
    }
    logger.info("slip OCR extracted", { provider: "gemini" });
    return result;
  }
}

export function createProductionSlipExtractor(
  env: Env = process.env,
  deps: { gemini?: () => SlipExtractor; legacy?: () => SlipExtractor } = {},
): SlipExtractor {
  const legacy = deps.legacy?.() ?? new CascadingSlipExtractor();
  if (!isGeminiSlipOcrEnabled(env)) return legacy;
  if (!env.GEMINI_API_KEY?.trim()) {
    logger.warn("slip Gemini OCR enabled but GEMINI_API_KEY is missing - using legacy OCR", {
      provider: "gemini",
    });
    return legacy;
  }
  return new GeminiFirstSlipExtractor(
    deps.gemini?.() ?? new GeminiSlipExtractor(
      env.GEMINI_API_KEY,
      env.SLIP_GEMINI_MODEL ?? DEFAULT_GEMINI_SLIP_MODEL,
      fetch,
      PRODUCTION_GEMINI_CALL_TIMEOUT_MS,
    ),
    legacy,
  );
}
