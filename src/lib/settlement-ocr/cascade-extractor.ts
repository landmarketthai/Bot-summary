import {
  checkSettlementArithmetic,
  DOCUMENT_TYPE_CONFIDENCE_THRESHOLD,
  isFieldConfident,
  isLikelySettlementSheet,
} from "@/lib/settlement-ocr/extraction-schema";
import { OpenAiSettlementSheetExtractor, SettlementSheetExtractionHttpError } from "@/lib/settlement-ocr/extractor";
import type {
  SettlementSheetExtraction,
  SettlementSheetExtractionInput,
  SettlementSheetExtractor,
} from "@/lib/settlement-ocr/types";
import { logger } from "@/lib/logger";

const PRIMARY_MODEL_ENV = "SETTLEMENT_SHEET_EXTRACTION_MODEL_PRIMARY";
const FALLBACK_MODEL_ENV = "SETTLEMENT_SHEET_EXTRACTION_MODEL_FALLBACK";
const PROVIDER = "openai";

/**
 * Whether a completed primary-pass read is trustworthy enough to skip the
 * fallback model. Deliberately the SAME gate draft-service.ts already uses
 * for NEEDS_REVIEW (missing/low-confidence required field, arithmetic
 * mismatch) â€” a primary read that would already need human review is
 * exactly the case worth spending a second model call on.
 */
function isPrimaryReadTrustworthy(extraction: SettlementSheetExtraction): boolean {
  if (
    extraction.documentType === "OTHER"
    && extraction.documentTypeConfidence >= DOCUMENT_TYPE_CONFIDENCE_THRESHOLD
  ) return true;
  if (!isLikelySettlementSheet(extraction)) return false; // ambiguous document classification: use fallback when configured â€” nothing to re-read
  const requiredFields = [
    extraction.salesTotal,
    extraction.transferAmount,
    extraction.cashSubmitted,
    extraction.expensesTotal,
    extraction.laborTotal,
    extraction.cashRemaining,
  ];
  if (requiredFields.some((field) => field.value === null || !isFieldConfident(field))) return false;

  const arithmetic = checkSettlementArithmetic({
    salesTotal: extraction.salesTotal.value,
    transferAmount: extraction.transferAmount.value,
    cashSubmitted: extraction.cashSubmitted.value,
    expensesTotal: extraction.expensesTotal.value,
    laborTotal: extraction.laborTotal.value,
    cashRemaining: extraction.cashRemaining.value,
  });
  return arithmetic.ok !== false;
}

function isRetryableProviderFailure(error: unknown): boolean {
  return error instanceof SettlementSheetExtractionHttpError && error.retryable;
}

function tag(
  extraction: SettlementSheetExtraction,
  model: string,
  pass: "primary" | "fallback",
): SettlementSheetExtraction {
  return { ...extraction, extractionProvider: PROVIDER, extractionModel: model, extractionPass: pass };
}

/**
 * Primary/fallback cascade around OpenAiSettlementSheetExtractor. Models are
 * env-configured only â€” never hardcode an unverified model name here â€” so
 * Production can point SETTLEMENT_SHEET_EXTRACTION_MODEL_PRIMARY /
 * _FALLBACK at new models without a code change. Fallback is skipped
 * entirely (safe default) when the fallback env var is unset.
 */
export class CascadingSettlementSheetExtractor implements SettlementSheetExtractor {
  private readonly primary: SettlementSheetExtractor;
  private readonly fallback: SettlementSheetExtractor | null;
  private readonly primaryModel: string;
  private readonly fallbackModel: string | null;

  constructor(
    primaryModel = process.env[PRIMARY_MODEL_ENV] ?? process.env.SETTLEMENT_SHEET_EXTRACTION_MODEL,
    fallbackModel = process.env[FALLBACK_MODEL_ENV] ?? null,
    buildExtractor: (model: string | undefined) => SettlementSheetExtractor =
      (model) => new OpenAiSettlementSheetExtractor(undefined, model),
  ) {
    this.primary = buildExtractor(primaryModel);
    this.primaryModel = primaryModel ?? "gpt-4o-mini"; // mirrors extractor.ts's own default when unset
    this.fallbackModel = fallbackModel;
    this.fallback = fallbackModel ? buildExtractor(fallbackModel) : null;
  }

  async extract(input: SettlementSheetExtractionInput): Promise<SettlementSheetExtraction> {
    let primaryResult: SettlementSheetExtraction | null = null;
    try {
      primaryResult = await this.primary.extract(input);
    } catch (error) {
      if (!this.fallback || !isRetryableProviderFailure(error)) throw error;
      logger.warn("settlement sheet primary extraction failed â€” trying fallback model", {
        primaryModel: this.primaryModel,
        fallbackModel: this.fallbackModel,
        error: error instanceof Error ? error.message : String(error),
      });
      return tag(await this.fallback.extract(input), this.fallbackModel!, "fallback");
    }

    if (!this.fallback || isPrimaryReadTrustworthy(primaryResult)) {
      return tag(primaryResult, this.primaryModel, "primary");
    }

    logger.info("settlement sheet extraction: primary read needs review â€” trying fallback model", {
      primaryModel: this.primaryModel,
      fallbackModel: this.fallbackModel,
    });
    return tag(await this.fallback.extract(input), this.fallbackModel!, "fallback");
  }
}
