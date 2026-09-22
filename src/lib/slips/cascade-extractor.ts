import { determineSlipCheckStatus, type SlipExtraction } from "@/lib/slips/extraction-schema";
import {
  ExtractionHttpError,
  OpenAiSlipExtractor,
  type SlipExtractionInput,
  type SlipExtractor,
} from "@/lib/slips/extractor";
import { logger } from "@/lib/logger";

const PRIMARY_MODEL_ENV = "SLIP_EXTRACTION_MODEL_PRIMARY";
const FALLBACK_MODEL_ENV = "SLIP_EXTRACTION_MODEL_FALLBACK";
const MIN_PRIMARY_CONFIDENCE = 0.85;

function isPrimaryReadTrustworthy(extraction: SlipExtraction): boolean {
  // A confident non-payment classification is already the answer. Spending a
  // second model call on an ordinary photo/white paper is wasted cost and can
  // only make the fail-closed result less stable.
  if (
    extraction.slipType === "UNKNOWN"
    || extraction.slipType === "NUMBERS_ONLY"
    || extraction.slipType === "WHITE_PAPER"
  ) return extraction.confidence >= MIN_PRIMARY_CONFIDENCE;

  return determineSlipCheckStatus(extraction) === "EXTRACTED"
    && extraction.confidence >= MIN_PRIMARY_CONFIDENCE;
}

function isRetryableProviderFailure(error: unknown): boolean {
  return error instanceof ExtractionHttpError && error.retryable;
}

/** Cost-aware primary/fallback OCR. Model IDs are env-configured so Production
 * can use Luna -> Sol without hardcoding model names in source. */
export class CascadingSlipExtractor implements SlipExtractor {
  private readonly primary: SlipExtractor;
  private readonly fallback: SlipExtractor | null;

  constructor(
    private readonly primaryModel = process.env[PRIMARY_MODEL_ENV] ?? process.env.SLIP_EXTRACTION_MODEL,
    private readonly fallbackModel = process.env[FALLBACK_MODEL_ENV] ?? null,
    buildExtractor: (model: string | undefined) => SlipExtractor =
      (model) => new OpenAiSlipExtractor(undefined, model),
  ) {
    this.primary = buildExtractor(primaryModel);
    this.fallback = fallbackModel ? buildExtractor(fallbackModel) : null;
  }

  async extract(input: SlipExtractionInput): Promise<SlipExtraction> {
    let primaryResult: SlipExtraction;
    try {
      primaryResult = await this.primary.extract(input);
    } catch (error) {
      if (!this.fallback || !isRetryableProviderFailure(error)) throw error;
      logger.warn("slip primary extraction failed - trying fallback model", {
        primaryModel: this.primaryModel ?? "default",
        fallbackModel: this.fallbackModel,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.fallback.extract(input);
    }

    if (!this.fallback || isPrimaryReadTrustworthy(primaryResult)) return primaryResult;

    logger.info("slip primary read needs review - trying fallback model", {
      primaryModel: this.primaryModel ?? "default",
      fallbackModel: this.fallbackModel,
      primaryStatus: determineSlipCheckStatus(primaryResult),
      primaryConfidence: primaryResult.confidence,
    });
    return this.fallback.extract(input);
  }
}
