import type { SlipExtraction } from "@/lib/slips/extraction-schema";
import type { SlipExtractor } from "@/lib/slips/extractor";
import { DEFAULT_GEMINI_SLIP_MODEL, GeminiSlipExtractor } from "@/lib/slips/gemini-extractor";
import { logger } from "@/lib/logger";

/** Env kill switch. Only the exact value "true" (trimmed) enables slip OCR.
 * Gemini is the ONLY slip OCR provider: there is no OpenAI fallback. Unset,
 * anything else, or a missing GEMINI_API_KEY fails every OCR job closed
 * (slip check FAILED, nothing counted) with an actionable failure reason. */
export const SLIP_GEMINI_OCR_ENABLED_ENV = "SLIP_GEMINI_OCR_ENABLED";
/** Two Gemini attempts must fit inside the 30s OCR redrive job budget
 * (SLIP_INGEST_POLICY.io.ocrJobTimeoutMs) alongside the image download. */
export const PRODUCTION_GEMINI_CALL_TIMEOUT_MS = 10_000;
export const SLIP_OCR_DISABLED_MESSAGE = "Slip OCR is disabled: set SLIP_GEMINI_OCR_ENABLED=true";
export const SLIP_OCR_NOT_CONFIGURED_MESSAGE = "GEMINI_API_KEY is not configured";

type Env = Record<string, string | undefined>;

export function isGeminiSlipOcrEnabled(env: Env = process.env): boolean {
  return env[SLIP_GEMINI_OCR_ENABLED_ENV]?.trim() === "true";
}

/** Fails every extraction with a fixed, secret-free message. */
class UnavailableSlipExtractor implements SlipExtractor {
  constructor(private readonly message: string) {}

  async extract(): Promise<SlipExtraction> {
    throw new Error(this.message);
  }
}

/** False for the fail-closed extractor (flag off / key missing): no retry or cooldown applies. */
export function isSlipExtractorAvailable(extractor: SlipExtractor): boolean {
  return !(extractor instanceof UnavailableSlipExtractor);
}

export function createProductionSlipExtractor(
  env: Env = process.env,
  deps: { gemini?: () => SlipExtractor } = {},
): SlipExtractor {
  if (!isGeminiSlipOcrEnabled(env)) {
    logger.warn("slip OCR disabled - OCR jobs fail closed", { provider: "gemini", reason: "disabled" });
    return new UnavailableSlipExtractor(SLIP_OCR_DISABLED_MESSAGE);
  }
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    logger.warn("slip OCR enabled but GEMINI_API_KEY is missing - OCR jobs fail closed", {
      provider: "gemini", reason: "not_configured",
    });
    return new UnavailableSlipExtractor(SLIP_OCR_NOT_CONFIGURED_MESSAGE);
  }
  return deps.gemini?.() ?? new GeminiSlipExtractor(
    apiKey,
    env.SLIP_GEMINI_MODEL?.trim() || DEFAULT_GEMINI_SLIP_MODEL,
    fetch,
    PRODUCTION_GEMINI_CALL_TIMEOUT_MS,
  );
}
