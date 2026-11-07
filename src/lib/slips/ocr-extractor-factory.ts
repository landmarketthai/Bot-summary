import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { CascadingSlipExtractor } from "@/lib/slips/cascade-extractor";
import type { SlipExtraction } from "@/lib/slips/extraction-schema";
import {
  ExtractionHttpError,
  type SlipExtractionInput,
  type SlipExtractor,
} from "@/lib/slips/extractor";
import { GeminiSlipExtractor } from "@/lib/slips/gemini-extractor";
import { SLIP_INGEST_POLICY } from "@/lib/slips/ingest-policy";
import { withTimeout } from "@/lib/slips/io-timeout";
import {
  GeminiQuotaUnavailableError,
  createGeminiRequestPermit,
  type GeminiRequestPermit,
} from "@/lib/slips/gemini-rate-limit";

/**
 * Selects the OCR transcription extractor used when EasySlip did NOT verify a
 * slip. OCR output is never bank verification; this only decides which model
 * reads the image.
 *
 * SLIP_GEMINI_OCR_ENABLED !== "true" (default) => legacy OpenAI cascade,
 * exactly as before. Rollback = unset the flag.
 */

type Env = Record<string, string | undefined>;

export interface GeminiBuildOptions {
  apiKey: string;
  model?: string;
  acquirePermit: GeminiRequestPermit;
  /** Gemini's share of the whole-job cap (permit waits + attempts). */
  jobTimeoutMs: number;
}

// ingest-policy: ocrJobTimeoutMs is the hard cap for one whole OCR job,
// fallback included (cron lane budget and webhook maxDuration rely on it).
const OCR_JOB_MS = SLIP_INGEST_POLICY.io.ocrJobTimeoutMs;
// With a fallback, Gemini gets one call's worth so OpenAI keeps the rest.
const GEMINI_SHARE_WITH_FALLBACK_MS = SLIP_INGEST_POLICY.io.ocrCallTimeoutMs;

export interface SlipOcrExtractorDeps {
  buildGemini?: (options: GeminiBuildOptions) => SlipExtractor;
  buildOpenAi?: () => SlipExtractor;
  createPermit?: (supabase: SupabaseClient) => GeminiRequestPermit;
}

let warnedMissingGeminiKey = false;

/** Test-only: reset the once-per-process missing-key warning latch. */
export function resetSlipOcrFactoryWarningsForTests(): void {
  warnedMissingGeminiKey = false;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Reason class only: never the message (may carry provider response text). */
function geminiFailureClass(error: unknown): string {
  if (error instanceof GeminiQuotaUnavailableError) return `quota_${error.reason}`;
  if (error instanceof ExtractionHttpError) return `http_${error.failureCode}`;
  if (error instanceof Error) return error.name || "Error";
  return "non_error_throw";
}

export class GeminiFirstSlipExtractor implements SlipExtractor {
  private openAi: SlipExtractor | null = null;

  constructor(
    private readonly gemini: SlipExtractor,
    private readonly buildOpenAi: (() => SlipExtractor) | null,
    private readonly jobTimeoutMs: number = OCR_JOB_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async extract(input: SlipExtractionInput): Promise<SlipExtraction> {
    const deadline = this.now() + this.jobTimeoutMs;
    try {
      // Any returned result (even low-confidence) is final: downstream status
      // logic routes weak reads to review. OpenAI is only an outage fallback.
      return await this.gemini.extract(input);
    } catch (error) {
      const reason = geminiFailureClass(error);
      if (!this.buildOpenAi) {
        logger.warn("slip Gemini OCR failed; OpenAI fallback disabled", { reason });
        throw error;
      }
      logger.warn("slip Gemini OCR failed; falling back to OpenAI OCR", { reason });
      this.openAi ??= this.buildOpenAi();
      const openAi = this.openAi;
      // ponytail: abandons (does not abort) a slow fallback call at the cap; the
      // late result is dropped, the OCR terminal write is claim-token fenced.
      return withTimeout("ocr_fallback", deadline - this.now(), () => openAi.extract(input));
    }
  }
}

export function createSlipOcrExtractor(
  supabase: SupabaseClient,
  env: Env = process.env,
  deps: SlipOcrExtractorDeps = {},
): SlipExtractor {
  const buildOpenAi = deps.buildOpenAi ?? (() => new CascadingSlipExtractor());

  if (env.SLIP_GEMINI_OCR_ENABLED !== "true") return buildOpenAi();

  const apiKey = nonEmpty(env.GEMINI_API_KEY);
  if (!apiKey) {
    if (!warnedMissingGeminiKey) {
      warnedMissingGeminiKey = true;
      logger.warn("SLIP_GEMINI_OCR_ENABLED is true but GEMINI_API_KEY is missing; using OpenAI OCR");
    }
    return buildOpenAi();
  }

  const createPermit = deps.createPermit ?? ((client: SupabaseClient) => createGeminiRequestPermit(client));
  const buildGemini = deps.buildGemini
    ?? ((options: GeminiBuildOptions) => new GeminiSlipExtractor(options));

  const fallbackAllowed = env.SLIP_GEMINI_OPENAI_FALLBACK !== "false" && nonEmpty(env.OPENAI_API_KEY) !== null;
  const gemini = buildGemini({
    apiKey,
    model: nonEmpty(env.SLIP_GEMINI_MODEL) ?? undefined,
    acquirePermit: createPermit(supabase),
    jobTimeoutMs: fallbackAllowed ? GEMINI_SHARE_WITH_FALLBACK_MS : OCR_JOB_MS,
  });
  return new GeminiFirstSlipExtractor(gemini, fallbackAllowed ? buildOpenAi : null);
}
