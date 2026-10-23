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
import { EasySlipBankVerifier, EasySlipVerificationError, buildEasySlipBankMessage, isEasySlipEnabledForSource, type BankSlipVerifier } from "@/lib/slips/easyslip-bank";
import { CascadingSlipExtractor } from "@/lib/slips/cascade-extractor";
import { findSlipTransactionDuplicate } from "@/lib/slips/transaction-dedupe";
import { buildSlipTransactionDuplicateWarning } from "@/lib/slips/transaction-duplicate-warning";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;
type PushMessage = (to: string, text: string) => Promise<void>;

const defaultPushMessage: PushMessage = async (to, text) => {
  await pushLineMessage(to, text);
};

/** Default OCR lease; a worker that outlives it loses its fencing token. */
export const SLIP_CHECK_LEASE_SECONDS = 300;

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
type RpcClient = { rpc?: (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult> };

interface CheckClaim {
  checkId: string;
  /** Fencing token; null only on the legacy path (claim RPCs not deployed). */
  token: number | null;
}

/**
 * True ONLY when the claim functions are verifiably not deployed: Postgres
 * undefined_function, PostgREST "function not found", or a unit double with no
 * rpc at all. Timeouts and every other error must NOT fall back to the
 * unfenced upsert, which can overwrite a successful check.
 */
function isMissingClaimRpc(error: { code?: string; message?: string } | null): boolean {
  return error?.code === "42883"
    || error?.code === "PGRST202"
    || /^unexpected(?: .*?)?rpc/i.test(error?.message ?? "");
}

export interface SlipCheckProcessor {
  processEvidence(evidenceId: string): Promise<void>;
}

export class SlipCheckService implements SlipCheckProcessor {
  constructor(
    private readonly supabase: Supabase,
    private readonly extractor: SlipExtractor = new CascadingSlipExtractor(),
    private readonly pushMessage: PushMessage = defaultPushMessage,
    private readonly leaseSeconds: number = SLIP_CHECK_LEASE_SECONDS,
    private readonly bankVerifier: BankSlipVerifier = new EasySlipBankVerifier(),
  ) {}

  async processEvidence(evidenceId: string): Promise<void> {
    const log = logger.child({ evidenceId });
    let checkId: string | null = null;
    let claimToken: number | null = null;
    // Track whether this evidence belongs to a batch so we can suppress the
    // per-image LINE push (the batch finalizer sends a single summary instead).
    let isInBatch = false;

    let imageSizeBytes = 0;

    try {
      const evidence = await this.loadEvidence(evidenceId);
      isInBatch = evidence.batch_id !== null;
      const claim = await this.claimCheck(evidenceId, log);
      if (!claim) return; // terminal, leased by a live worker, or batch no longer open
      checkId = claim.checkId;
      claimToken = claim.token;
      const bytes = await this.downloadEvidence(
        evidence.storage_bucket,
        evidence.storage_path,
      );
      imageSizeBytes = bytes.length;
      const input = { bytes, mimeType: evidence.mime_type ?? "image/jpeg" };
      // Explicit opt-in LINE sources only. EasySlip handles bank QR before AI OCR.
      const easySlipEnabled = isEasySlipEnabledForSource(evidence.source_id);
      const bankResult = easySlipEnabled ? await this.bankVerifier.verifyImage(input) : null;
      const extraction = bankResult?.kind === "verified"
        ? bankResult.extraction
        : await this.extractor.extract(input);
      const isBank = extraction.slipType === "BANK_SLIP_QR" || extraction.slipType === "BANK_SLIP_NO_QR";
      // No QR match, duplicate, or receiver mismatch must never count as verified money.
      const manualBankReview = bankResult?.kind === "verified"
        ? bankResult.isDuplicate || !bankResult.accountMatched
        : easySlipEnabled && isBank;
      const status = manualBankReview ? "NEED_REVIEW" : determineSlipCheckStatus(extraction);
      const providerMeta = bankResult?.kind === "verified"
        ? { provider: "easyslip", duplicate: bankResult.isDuplicate, receiver_account_matched: bankResult.accountMatched,
            bank_verified: !manualBankReview }
        : easySlipEnabled && isBank
          ? { provider: "easyslip", bank_verified: false, reason: "slip_not_found" }
          : null;

      const fields = {
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
        extracted_json: providerMeta
          ? { ...(extractionToJson(extraction) as Record<string, unknown>), verification: providerMeta }
          : extractionToJson(extraction),
      };

      if (claimToken !== null) {
        const outcome = await this.completeCheck(checkId, claimToken, status, fields);
        if (outcome !== "completed") {
          // Stale worker, finished check or finalized batch: the stored row is
          // authoritative. Do not overwrite it and do not notify.
          log.warn("slip extraction result discarded", { checkId, outcome });
          return;
        }
      } else {
        const { error: updateError } = await this.supabase
          .from("slip_checks")
          .update({ status, ...fields, failure_reason: null })
          .eq("id", checkId);
        if (updateError) throw new Error("Could not save extracted slip fields");
      }

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
          duplicateWarning ?? (providerMeta && isBank
            ? buildEasySlipBankMessage(extraction, status, providerMeta)
            : buildSlipLineSummary(extraction, status)),
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

      let failureRecorded = true;
      if (checkId) {
        if (claimToken !== null) {
          const outcome = await this.failCheck(checkId, claimToken, failureReason, log);
          // A stale worker must not notify: the check belongs to a newer claim
          // (or is already terminal) and the real result is reported there.
          if (outcome === "stale_claim" || outcome === "already_terminal" || outcome === "batch_not_open") {
            failureRecorded = false;
            log.warn("slip failure not recorded", { checkId, outcome });
          }
        } else {
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
      }

      if (!isInBatch && failureRecorded) {
        const sourceId = await this.findSourceId(evidenceId);
        if (sourceId) {
          await this.pushSummary(
            sourceId,
            error instanceof EasySlipVerificationError
              ? "🟠 EasySlip ตรวจสอบสลิปไม่ได้ในขณะนี้\nรายการยังไม่ถูกนับเป็นยอดที่ตรวจสอบผ่าน\nโปรดให้ผู้ดูแลตรวจสอบหรือลองส่งใหม่"
              : buildSlipLineSummary(emptyExtraction, "FAILED"),
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

  /**
   * Wins the OCR claim (insert PROCESSING, or re-claim an EXPIRED PROCESSING
   * lease) and returns the fencing token. Returns null when another live
   * worker holds it, the check is already terminal, or the batch is no longer
   * collecting/closing. The unfenced upsert is used only when the claim RPC is
   * verifiably not deployed.
   */
  private async claimCheck(
    evidenceId: string,
    log: ReturnType<typeof logger.child>,
  ): Promise<CheckClaim | null> {
    const client = this.supabase as unknown as RpcClient;
    if (typeof client.rpc === "function") {
      const { data, error } = await client.rpc("claim_slip_check", {
        p_evidence_id: evidenceId,
        p_lease_seconds: this.leaseSeconds,
      });
      if (!error) {
        const claim = data as { claimed?: boolean; check_id?: string; token?: number; reason?: string } | null;
        if (claim?.claimed === true && claim.check_id && typeof claim.token === "number") {
          return { checkId: claim.check_id, token: claim.token };
        }
        if (claim?.claimed === false) {
          log.info("slip check not claimed", { reason: claim.reason ?? "unknown" });
          return null;
        }
        throw new Error("Slip check could not be created");
      }
      if (!isMissingClaimRpc(error)) throw new Error("Slip check could not be created");
      // A missing OCR RPC on a ledger database is a partial rollout/cache
      // failure, not permission to bypass fencing with the legacy upsert.
      const ledger = await client.rpc("slip_image_ledger_health", {});
      if (!ledger.error || !isMissingClaimRpc(ledger.error)) {
        throw new Error("Slip OCR migration 20261017110000 is required");
      }
    }
    return { checkId: await this.createProcessingCheckLegacy(evidenceId), token: null };
  }

  private async completeCheck(
    checkId: string,
    token: number,
    status: string,
    fields: Record<string, unknown>,
  ): Promise<string> {
    const client = this.supabase as unknown as RpcClient;
    const { data, error } = await client.rpc!("complete_slip_check", {
      p_check_id: checkId,
      p_token: token,
      p_status: status,
      p_fields: fields,
    });
    if (error) throw new Error("Could not save extracted slip fields");
    return (data as { outcome?: string } | null)?.outcome ?? "unknown";
  }

  private async failCheck(
    checkId: string,
    token: number,
    reason: string,
    log: ReturnType<typeof logger.child>,
  ): Promise<string> {
    try {
      const client = this.supabase as unknown as RpcClient;
      const { data, error } = await client.rpc!("fail_slip_check", {
        p_check_id: checkId,
        p_token: token,
        p_reason: reason,
      });
      if (error) {
        log.error("failed to mark slip check as failed", { reason: "database_update_failed" });
        return "error";
      }
      return (data as { outcome?: string } | null)?.outcome ?? "unknown";
    } catch {
      log.error("failed to mark slip check as failed", { reason: "database_update_failed" });
      return "error";
    }
  }

  // Pre-migration schema only (claim RPCs missing). Unfenced.
  private async createProcessingCheckLegacy(evidenceId: string): Promise<string> {
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

  if (error instanceof EasySlipVerificationError) return `easyslip_${error.reason}`;
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
