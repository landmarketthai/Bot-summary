import type { SupabaseClient } from "@supabase/supabase-js";
import { pushLineMessage } from "@/lib/line/reply";
import { logger } from "@/lib/logger";
import {
  determineSlipCheckStatus,
  extractionToJson,
} from "@/lib/slips/extraction-schema";
import {
  ExtractionHttpError,
  type SlipExtractor,
} from "@/lib/slips/extractor";
import { buildSlipLineSummary } from "@/lib/slips/line-summary";
import { CascadingSlipExtractor } from "@/lib/slips/cascade-extractor";
import { findSlipTransactionDuplicate } from "@/lib/slips/transaction-dedupe";
import { buildSlipTransactionDuplicateWarning } from "@/lib/slips/transaction-duplicate-warning";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;
type PushMessage = (to: string, text: string) => Promise<void>;

const defaultPushMessage: PushMessage = async (to, text) => {
  await pushLineMessage(to, text);
};

export interface SlipCheckProcessor {
  processEvidence(evidenceId: string): Promise<void>;
}

export class SlipCheckService implements SlipCheckProcessor {
  constructor(
    private readonly supabase: Supabase,
    private readonly extractor: SlipExtractor = new CascadingSlipExtractor(),
    private readonly pushMessage: PushMessage = defaultPushMessage,
  ) {}

  async processEvidence(evidenceId: string): Promise<void> {
    const log = logger.child({ evidenceId });
    let checkId: string | null = null;
    // Track whether this evidence belongs to a batch so we can suppress the
    // per-image LINE push (the batch finalizer sends a single summary instead).
    let isInBatch = false;

    let imageSizeBytes = 0;

    try {
      const evidence = await this.loadEvidence(evidenceId);
      isInBatch = evidence.batch_id !== null;
      checkId = await this.createProcessingCheck(evidenceId);
      const bytes = await this.downloadEvidence(
        evidence.storage_bucket,
        evidence.storage_path,
      );
      imageSizeBytes = bytes.length;
      const extraction = await this.extractor.extract({
        bytes,
        mimeType: evidence.mime_type ?? "image/jpeg",
      });
      const status = determineSlipCheckStatus(extraction);

      const { error: updateError } = await this.supabase
        .from("slip_checks")
        .update({
          status,
          slip_type: extraction.slipType,
          gross_amount: extraction.grossAmount,
          discount_amount: extraction.discountAmount,
          paid_amount: extraction.paidAmount,
          transfer_amount: extraction.transferAmount,
          reference_id: extraction.referenceId,
          transaction_time: extraction.transactionTime,
          sender_name: extraction.senderName,
          receiver_name: extraction.receiverName,
          receiver_account_tail: extraction.receiverAccountTail,
          confidence: extraction.confidence,
          extracted_json: extractionToJson(extraction),
          failure_reason: null,
        })
        .eq("id", checkId);

      if (updateError) throw new Error("Could not save extracted slip fields");

      log.info("slip extraction completed", {
        checkId,
        status,
        slipType: extraction.slipType,
        confidence: extraction.confidence,
        isInBatch,
      });

      // Skip per-image LINE push when the evidence is part of a batch.
      // The batch finalizer will aggregate results and send one summary
      // (it has its own in-batch duplicate flag via validation-guard.ts).
      if (!isInBatch) {
        const duplicateWarning = await this.checkTransactionDuplicate(
          checkId,
          status,
          extraction.referenceId,
          evidence.source_id,
          log,
        );
        await this.pushSummary(
          evidence.source_id,
          duplicateWarning ?? buildSlipLineSummary(extraction, status),
          log,
        );
      }
    } catch (error) {
      const failureReason = safeFailureReason(error);

      if (error instanceof ExtractionHttpError) {
        log.error("slip extraction failed", {
          checkId,
          reason:          failureReason,
          httpStatus:      error.httpStatus,
          failureCode:     error.failureCode,
          retryable:       error.retryable,
          responseSnippet: error.responseSnippet,
          durationMs:      error.durationMs,
          imageSizeBytes,
        });
      } else {
        log.error("slip extraction failed", { checkId, reason: failureReason });
      }

      if (checkId) {
        const { error: updateError } = await this.supabase
          .from("slip_checks")
          .update({
            status: "FAILED",
            failure_reason: failureReason,
          })
          .eq("id", checkId);

        if (updateError) {
          log.error("failed to mark slip check as failed", {
            reason: "database_update_failed",
          });
        }
      }

      if (!isInBatch) {
        const sourceId = await this.findSourceId(evidenceId);
        if (sourceId) {
          await this.pushSummary(
            sourceId,
            buildSlipLineSummary(emptyExtraction, "FAILED"),
            log,
          );
        }
      }
    }
  }

  private async loadEvidence(evidenceId: string) {
    const { data, error } = await this.supabase
      .from("slip_evidences")
      .select("id, source_id, storage_bucket, storage_path, mime_type, status, batch_id")
      .eq("id", evidenceId)
      .single();

    if (error || !data) throw new Error("Slip evidence could not be loaded");
    if (data.status !== "RECEIVED") throw new Error("Slip evidence is not ready");
    return data;
  }

  private async createProcessingCheck(evidenceId: string): Promise<string> {
    const { data, error } = await this.supabase
      .from("slip_checks")
      .upsert(
        {
          evidence_id: evidenceId,
          status: "PROCESSING",
          slip_type: "UNKNOWN",
          failure_reason: null,
        },
        { onConflict: "evidence_id" },
      )
      .select("id")
      .single();

    if (error || !data) throw new Error("Slip check could not be created");
    return data.id;
  }

  private async downloadEvidence(bucket: string, path: string): Promise<Uint8Array> {
    const { data, error } = await this.supabase.storage.from(bucket).download(path);
    if (error || !data) throw new Error("Private slip evidence could not be downloaded");
    return new Uint8Array(await data.arrayBuffer());
  }

  private async findSourceId(evidenceId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from("slip_evidences")
      .select("source_id")
      .eq("id", evidenceId)
      .maybeSingle();
    return data?.source_id ?? null;
  }

  private async pushSummary(
    sourceId: string,
    text: string,
    log: ReturnType<typeof logger.child>,
  ): Promise<void> {
    try {
      await this.pushMessage(sourceId, text);
    } catch {
      log.error("slip summary push failed", { reason: "line_push_failed" });
    }
  }

  // Returns a duplicate-warning message to push instead of the normal
  // summary, or null when the slip is unique / has no reference id to
  // check. A lookup failure fails open (falls back to the normal summary)
  // rather than re-throwing — the extraction itself already succeeded and
  // was saved, so this must not flip the check to FAILED.
  private async checkTransactionDuplicate(
    checkId: string,
    status: ReturnType<typeof determineSlipCheckStatus>,
    referenceId: string | null,
    sourceId: string,
    log: ReturnType<typeof logger.child>,
  ): Promise<string | null> {
    if (status !== "EXTRACTED" && status !== "PARTIAL_EXTRACTED") return null;
    if (!referenceId) return null;

    try {
      const duplicate = await findSlipTransactionDuplicate(this.supabase, {
        rawTransactionId: referenceId,
        sourceId,
        excludeCheckId: checkId,
      });

      if (duplicate.status !== "duplicate_same_source" && duplicate.status !== "duplicate_cross_source") {
        return null;
      }

      log.warn("slip transaction duplicate detected", {
        checkId,
        duplicateStatus: duplicate.status,
        originalRecordId: duplicate.originalRecordId,
      });
      return buildSlipTransactionDuplicateWarning(duplicate);
    } catch (error) {
      log.error("slip transaction duplicate lookup failed", {
        checkId,
        reason: error instanceof Error ? error.message : "unknown",
      });
      return null;
    }
  }
}

const emptyExtraction = {
  slipType: "UNKNOWN" as const,
  grossAmount: null,
  discountAmount: null,
  paidAmount: null,
  transferAmount: null,
  referenceId: null,
  transactionTime: null,
  senderName: null,
  receiverName: null,
  receiverAccountTail: null,
  paymentChannelText: null,
  headlineTotalAmount: null,
  confidence: 0,
};

function safeFailureReason(error: unknown): string {
  // Specific HTTP error with a classified failure code — most useful for diagnostics.
  if (error instanceof ExtractionHttpError) {
    return `extractor_http_${error.failureCode}`;
  }

  if (!(error instanceof Error)) return "unknown_extraction_failure";

  const knownMessages: Record<string, string> = {
    "OPENAI_API_KEY is not configured": "extractor_not_configured",
    "Slip evidence could not be loaded": "evidence_load_failed",
    "Slip evidence is not ready": "evidence_not_ready",
    "Slip check could not be created": "check_create_failed",
    "Private slip evidence could not be downloaded": "evidence_download_failed",
    "Could not save extracted slip fields": "check_update_failed",
    "Image extraction provider returned no structured output": "extractor_empty_output",
    "Image extraction provider returned invalid JSON": "extractor_invalid_output",
    "Extractor returned a non-object result": "extractor_invalid_output",
  };

  if (knownMessages[error.message]) return knownMessages[error.message];
  // Fallback for any HTTP error that bypassed ExtractionHttpError (shouldn't happen).
  if (error.message.startsWith("Image extraction provider returned HTTP ")) {
    return "extractor_http_error";
  }
  return "unknown_extraction_failure";
}
