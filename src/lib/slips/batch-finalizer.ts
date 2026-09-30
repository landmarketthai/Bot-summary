import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, SlipCheckStatus, SlipBatchRow, SlipType } from "@/types/database";
import { LinePushError, pushLineMessage } from "@/lib/line/reply";
import { logger } from "@/lib/logger";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { tryFinalizeSettlement } from "@/lib/settlement-finalizer";
import {
  isVerifiedSlipCheckStatus,
  normalizeTransactionId,
  resolveGloballyAcceptedCheckIds,
} from "@/lib/slips/transaction-dedupe";
import {
  computeValidationFlags,
  parseBatchDate,
  type EvidenceFlags,
  type ValidationReason,
} from "./validation-guard";

/**
 * Parses SLIP_ABANDONED_SESSION_MINUTES env-var safely.
 * Returns 60 for any invalid, empty, NaN, zero, or negative value.
 * parseInt("", 10) returns NaN; Math.max(1, NaN) also returns NaN — hence the
 * explicit isFinite guard.
 */
export function parseAbandonedMinutes(value: string | undefined): number {
  if (!value) return 60;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 60;
  return Math.max(1, parsed);
}

/**
 * Parses a closing-window seconds env-var (SLIP_CLOSE_QUIET_SECONDS or
 * SLIP_CLOSE_MAX_SECONDS).  Returns `defaultValue` for invalid / missing input.
 */
export function parseCloseSeconds(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.max(1, parsed);
}

// How long a collecting batch must be idle before the fallback finalizer
// treats it as abandoned.  Env var is in minutes; default 60.
const SLIP_ABANDONED_SESSION_MINUTES = parseAbandonedMinutes(
  process.env.SLIP_ABANDONED_SESSION_MINUTES,
);

// After "จบสลิป" (closing state): wait this long after the last image before
// considering the batch quiet enough to finalize.  Default 10 s gives late-
// arriving LINE webhooks time to deliver.
const CLOSE_QUIET_SECONDS = parseCloseSeconds(
  process.env.SLIP_CLOSE_QUIET_SECONDS,
  10,
);

// Hard upper limit on how long a closing batch can wait before the finalizer
// gives up waiting for PROCESSING checks and sends the summary anyway.
const CLOSE_MAX_SECONDS = parseCloseSeconds(
  process.env.SLIP_CLOSE_MAX_SECONDS,
  120,
);

// A batch that has stayed in processing beyond two normal request windows is
// treated as stranded and becomes eligible for bounded automatic recovery.
const PROCESSING_RECOVERY_STALE_MINUTES = 2;
const PROCESSING_RECOVERY_LIMIT = 20;
const LINE_RETRY_KEY_WINDOW_HOURS = 24;

type Supabase = SupabaseClient<Database>;

// retryKey is the batch UUID passed as X-Line-Retry-Key for idempotent push.
type PushMessage = (to: string, text: string, retryKey?: string) => Promise<void>;

/**
 * Structured outcome from finalizeSlipBatch.
 *
 * delivered=true  persisted=true  — LINE delivered + DB updated; fully finalized.
 * delivered=true  persisted=false — LINE delivered (or already accepted) but the
 *                                   final DB update failed.  summary_sent_at is
 *                                   still null; a subsequent retry with the same
 *                                   batch-id retry key will skip LINE (409) and
 *                                   attempt the DB update again.
 *
 * void (undefined) is returned when the idempotency guard fires (summary_sent_at
 * already set by a previous call); callers that need to distinguish this case
 * should query summary_sent_at before calling.
 */
export type FinalizeResult =
  | { delivered: true; persisted: true }
  | { delivered: true; persisted: false; persistError: string };

export interface EvidenceWithCheck {
  id:              string;
  checkId?:         string | null;
  batchIndex:      number | null;
  checkStatus:     SlipCheckStatus | null;
  slipType:        SlipType | null;
  transferAmount:  number | null;
  paidAmount:      number | null;
  grossAmount?:    number | null;
  discountAmount?: number | null;
  transactionTime: string | null;
  referenceId?:    string | null;
  globallyDuplicate?: boolean;
  failureReason:   string | null;
}

/**
 * Claims and finalizes collecting slip_batches that have been idle for longer
 * than SLIP_ABANDONED_SESSION_MINUTES (default 60 min, env-configurable).
 * This is a safety-net for sessions the user never explicitly closed.
 * "จบสลิป" closes sessions immediately and independently of this timeout.
 *
 * Safe to call from concurrent workers: the collecting→processing transition
 * is a single UPDATE so only one caller can claim each batch.
 */
const defaultPush: PushMessage = async (to, text, retryKey) => {
  await pushLineMessage(to, text, retryKey);
};

export async function finalizeDueSlipBatches(
  supabase: Supabase,
  push: PushMessage = defaultPush,
  abandonedMinutes: number = SLIP_ABANDONED_SESSION_MINUTES,
): Promise<number> {
  const cutoff = new Date(
    Date.now() - abandonedMinutes * 60 * 1000,
  ).toISOString();

  const { data: claimed, error } = await supabase
    .from("slip_batches")
    .update({ status: "processing" })
    .eq("status", "collecting")
    .lte("last_image_at", cutoff)
    .select("id, source_id");

  if (error) {
    logger.error("finalize-slip-batches: claim failed", { reason: error.message });
    return 0;
  }

  const batches = claimed ?? [];
  for (const batch of batches) {
    await finalizeSlipBatch(supabase, batch.id, (text) => push(batch.source_id, text, batch.id));
  }
  return batches.length;
}

// ── Closing-batch atomic claim ────────────────────────────────────────────────

/**
 * Result from a successful atomic claim; null means not yet ready or already
 * claimed by a concurrent worker.
 */
interface ClaimResult {
  id:         string;
  source_id:  string;
  wasTimeout: boolean;
}

/**
 * Injectable claim function used by finalizeClosingSlipBatches.
 * Default implementation delegates to the claim_closing_slip_batch SQL RPC
 * which atomically locks the batch row, re-evaluates readiness while holding
 * the lock, and transitions status closing→processing if conditions are met.
 *
 * Serializes against attach_evidence_to_slip_batch because both operations
 * UPDATE the same slip_batches row (acquiring the same row-level lock).
 */
export type ClaimFn = (
  supabase:     Supabase,
  batchId:      string,
  quietSeconds: number,
  maxSeconds:   number,
) => Promise<ClaimResult | null>;

async function defaultAtomicClaim(
  supabase:     Supabase,
  batchId:      string,
  quietSeconds: number,
  maxSeconds:   number,
): Promise<ClaimResult | null> {
  const { data, error } = await supabase.rpc("claim_closing_slip_batch", {
    p_batch_id:      batchId,
    p_quiet_seconds: quietSeconds,
    p_max_seconds:   maxSeconds,
  });

  if (error) {
    logger.error("claim_closing_slip_batch RPC failed", { batchId, reason: error.message });
    return null;
  }

  const rows = data as Array<{ claimed_id: string; claimed_source_id: string; was_timeout: boolean }> | null;
  if (!rows || rows.length === 0) return null;
  return {
    id:         rows[0].claimed_id,
    source_id:  rows[0].claimed_source_id,
    wasTimeout: rows[0].was_timeout,
  };
}

/**
 * Finds every slip batch in 'closing' status and finalizes those that are ready.
 *
 * Readiness is evaluated inside claim_closing_slip_batch (SQL RPC) while
 * holding a row-level lock on the batch.  This prevents the following race:
 *
 *   • If a late image arrives and updates last_image_at before the claim locks
 *     the row, the RPC reads the fresh last_image_at and returns no rows
 *     (quiet period not yet elapsed) — image attachment wins.
 *   • If the claim locks the row first and transitions status to 'processing',
 *     attach_evidence_to_slip_batch's WHERE status IN ('collecting','closing')
 *     fails and raises an exception — finalizer wins, late image is rejected.
 *
 * Safe to call from concurrent workers: closing→processing transition is
 * inside the RPC and protected by the row-level lock.
 */
type FinalizeFn = (
  supabase:    Supabase,
  batchId:     string,
  sendMessage: (text: string) => Promise<void>,
  options?:    { isTimeoutForced?: boolean },
) => Promise<FinalizeResult | void>;

export async function finalizeClosingSlipBatches(
  supabase:     Supabase,
  push:         PushMessage = defaultPush,
  quietSeconds: number = CLOSE_QUIET_SECONDS,
  maxSeconds:   number = CLOSE_MAX_SECONDS,
  _finalize:    FinalizeFn = finalizeSlipBatch,
  _claim:       ClaimFn = defaultAtomicClaim,
): Promise<number> {
  const { data: closingBatches, error } = await supabase
    .from("slip_batches")
    .select("id, source_id")
    .eq("status", "closing");

  if (error) {
    logger.error("finalizeClosingSlipBatches: fetch failed", { reason: error.message });
    return 0;
  }

  let count = 0;
  for (const batch of closingBatches ?? []) {
    const claimed = await _claim(supabase, batch.id, quietSeconds, maxSeconds);
    if (!claimed) continue;

    await _finalize(
      supabase,
      claimed.id,
      (text) => push(claimed.source_id, text, claimed.id),
      { isTimeoutForced: claimed.wasTimeout },
    );
    count++;
  }

  return count;
}

export interface ProcessingRecoveryRun {
  due: number;
  recovered: number;
  failed: number;
  skippedOutsideRetryWindow: number;
  deferredByTimeBudget: number;
  movedToReview: number;
  /** Stale batches another concurrent sweep leased first. */
  claimConflicts: number;
}

/**
 * Retry slip batches that were claimed into processing but never finished.
 * Fresh rows are excluded by updated_at, retries keep the batch UUID as LINE's
 * retry key, and rows older than LINE's 24-hour retry-key window are left for
 * manual review.
 *
 * A permanent LINE rejection (non-retryable 4xx) would fail identically on
 * every sweep, so the batch moves to review_needed with summary_sent_at and
 * finalized_at still null. That state drops out of this sweep, keeps settlement
 * blocked, and stays retryable through the protected manual recover endpoint.
 */
export async function recoverStaleProcessingSlipBatches(
  supabase: Supabase,
  push: PushMessage = defaultPush,
  staleMinutes = PROCESSING_RECOVERY_STALE_MINUTES,
  limit = PROCESSING_RECOVERY_LIMIT,
  _finalize: FinalizeFn = finalizeSlipBatch,
): Promise<ProcessingRecoveryRun> {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
  // Only fetch rows still inside the retry-key window (closing_at ?? created_at).
  // Out-of-window rows are never leased, so their updated_at never moves; if
  // they shared the oldest-first page they would fill it on every sweep and
  // starve younger recoverable batches.
  const retryWindowStart = new Date(Date.now() - LINE_RETRY_KEY_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("slip_batches")
    .select("id, source_id, closing_at, created_at, updated_at")
    .eq("status", "processing")
    .is("summary_sent_at", null)
    .lte("updated_at", cutoff)
    .or(`closing_at.gte.${retryWindowStart},and(closing_at.is.null,created_at.gte.${retryWindowStart})`)
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (error) {
    logger.error("recover-stale-slip-batches: fetch failed", { reason: error.message });
    return {
      due: 0,
      recovered: 0,
      failed: 0,
      skippedOutsideRetryWindow: 0,
      deferredByTimeBudget: 0,
      movedToReview: 0,
      claimConflicts: 0,
    };
  }

  const batches = data ?? [];
  const run: ProcessingRecoveryRun = {
    due: batches.length,
    recovered: 0,
    failed: 0,
    skippedOutsideRetryWindow: 0,
    deferredByTimeBudget: 0,
    movedToReview: 0,
    claimConflicts: 0,
  };
  // GitHub Actions gives this cron caller 30 seconds. Keep recovery well below
  // that so normal batch finalization and network variance retain headroom.
  const deadlineMs = Date.now() + 15_000;

  for (const [index, batch] of batches.entries()) {
    if (Date.now() >= deadlineMs) {
      run.deferredByTimeBudget = batches.length - index;
      break;
    }
    const referenceTime = batch.closing_at ?? batch.created_at;
    const ageHours = (Date.now() - new Date(referenceTime).getTime()) / (60 * 60 * 1000);
    if (!Number.isFinite(ageHours) || ageHours > LINE_RETRY_KEY_WINDOW_HOURS) {
      run.skippedOutsideRetryWindow += 1;
      continue;
    }

    // Atomic lease, same conditional-UPDATE pattern as finalizeDueSlipBatches:
    // only the caller whose UPDATE still matches the stale updated_at wins.
    // trg_slip_batches_updated_at stamps now(), so an overlapping sweep or
    // scheduler retry no longer finalizes the same batch concurrently.
    const { data: leased, error: leaseError } = await supabase
      .from("slip_batches")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", batch.id)
      .eq("status", "processing")
      .is("summary_sent_at", null)
      .lte("updated_at", cutoff)
      .select("id")
      .maybeSingle();
    if (leaseError) {
      run.failed += 1;
      logger.error("recover-stale-slip-batches: lease failed", { batchId: batch.id, reason: leaseError.message });
      continue;
    }
    if (!leased) {
      run.claimConflicts += 1;
      continue;
    }

    try {
      const result = await _finalize(
        supabase,
        batch.id,
        (text) => push(batch.source_id, text, batch.id),
      );
      if (result && !result.persisted) run.failed += 1;
      else run.recovered += 1;
    } catch (recoveryError) {
      const reason = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      if (isPermanentLineRejection(recoveryError)) {
        // Conditional on processing + unsent so a concurrent finalize wins;
        // select id so a zero-row match is never counted as moved.
        const { data: moved, error: reviewError } = await supabase
          .from("slip_batches")
          .update({ status: "review_needed" })
          .eq("id", batch.id)
          .eq("status", "processing")
          .is("summary_sent_at", null)
          .select("id")
          .maybeSingle();
        if (moved) {
          run.movedToReview += 1;
          logger.error("recover-stale-slip-batches: permanent LINE failure — moved to review_needed for manual recovery", {
            batchId: batch.id,
            httpStatus: recoveryError.httpStatus,
            reason,
          });
          continue;
        }
        logger.error("recover-stale-slip-batches: review_needed transition not applied", {
          batchId: batch.id,
          reason: reviewError?.message ?? "no processing+unsent row matched (changed concurrently)",
        });
      }
      run.failed += 1;
      logger.error("recover-stale-slip-batches: retry failed", { batchId: batch.id, reason });
    }
  }

  return run;
}

/**
 * Permanent per-batch LINE rejection: non-retryable 4xx except 401/403.
 * 401/403 mean a bad/expired channel token or missing permission — systemic
 * config faults that recover once credentials are fixed, so those batches stay
 * in processing for the next sweep instead of fanning out into manual review.
 * 429/5xx/network are already retryable in LinePushError.
 */
function isPermanentLineRejection(error: unknown): error is LinePushError {
  return error instanceof LinePushError
    && !error.retryable
    && error.httpStatus !== null
    && error.httpStatus >= 400
    && error.httpStatus < 500
    && error.httpStatus !== 401
    && error.httpStatus !== 403;
}

export interface SlipBatchStateHealth {
  count: number;
  /** Age of the oldest such batch since it was created. */
  oldestAgeSeconds: number | null;
}

export interface SlipBatchHealth {
  /** processing with no summary sent: in-flight or awaiting stale recovery. */
  processingUnsent: SlipBatchStateHealth;
  /** review_needed with no summary sent: parked after a permanent LINE rejection. */
  reviewNeededUnsent: SlipBatchStateHealth;
}

/**
 * Two bounded reads (exact count + the single oldest row) for internal cron
 * output. Returns null on any read error so metrics never fail the sweep.
 */
export async function loadSlipBatchHealth(supabase: Supabase): Promise<SlipBatchHealth | null> {
  const nowMs = Date.now();
  const read = async (status: "processing" | "review_needed"): Promise<SlipBatchStateHealth> => {
    const { data, count, error } = await supabase
      .from("slip_batches")
      .select("created_at", { count: "exact" })
      .eq("status", status)
      .is("summary_sent_at", null)
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) throw new Error(error.message);
    const oldest = data?.[0]?.created_at;
    return {
      count: count ?? 0,
      oldestAgeSeconds: oldest ? Math.max(0, Math.floor((nowMs - Date.parse(oldest)) / 1000)) : null,
    };
  };
  try {
    const [processingUnsent, reviewNeededUnsent] = await Promise.all([
      read("processing"),
      read("review_needed"),
    ]);
    return { processingUnsent, reviewNeededUnsent };
  } catch (error) {
    logger.error("slip batch health read failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ── Single-batch finalization ─────────────────────────────────────────────────

/**
 * Finalizes a single slip batch that has already been claimed (status=processing).
 * Loads evidences, builds a summary, calls sendMessage, then updates the batch status.
 *
 * Used by both the cron finalizer and the abandoned-session path.
 *
 * DELIVERY LIFECYCLE (in order):
 *   1. [done by caller] Atomic claim: closing/collecting → processing
 *   2. Load batch row + evidences
 *   3. Build summary text
 *   4. LINE Push  (X-Line-Retry-Key set by the sendMessage closure in the caller)
 *   5. Persist delivery result: summary_sent_at, final status
 *
 * FAILURE HANDLING:
 *   Pre-send failure (messageSent=false): the batch stays in 'processing' with
 *   summary_sent_at=null.  It is NOT reverted to 'collecting' — reverting would
 *   re-open image collection on a batch the user already closed.  The stale-
 *   processing sweep retries it after two minutes while LINE's retry-key window
 *   is still safe; the protected admin endpoint remains the manual fallback.
 *
 *   Post-send DB failure (messageSent=true): the summary was delivered.  We log
 *   the error and return without throwing so the caller does not revert state.
 *   The batch stays in 'processing'; the summary_sent_at idempotency guard in
 *   subsequent runs prevents duplicate sends.
 *
 *   Repeated cron executions: the summary_sent_at guard at the top of this
 *   function causes early-return if the summary was already delivered — no
 *   duplicate sends during normal operation.
 */
export async function finalizeSlipBatch(
  supabase:    Supabase,
  batchId:     string,
  sendMessage: (text: string) => Promise<void>,
  options?:    { isTimeoutForced?: boolean },
): Promise<FinalizeResult | void> {
  const log = logger.child({ batchId });
  const isTimeoutForced = options?.isTimeoutForced ?? false;
  // Tracks whether LINE has already received the message.
  let messageSent = false;

  try {
    const [batchRow, loadedEvidences] = await Promise.all([
      loadBatchRow(supabase, batchId),
      loadBatchEvidences(supabase, batchId),
    ]);
    const evidences = await applyGlobalDuplicateExclusions(supabase, loadedEvidences);

    // Idempotency guard: if summary_sent_at is already set, another worker
    // (or a previous retry) already delivered the summary — skip silently.
    if (batchRow?.summary_sent_at) {
      log.warn("finalizeSlipBatch: summary already sent — skipping", {
        summarySetAt: batchRow.summary_sent_at,
      });
      return;
    }

    log.info("finalizing active slip batch", { evidenceCount: evidences.length, isTimeoutForced });

    if (evidences.length === 0) {
      log.warn("finalizeSlipBatch: no evidences — marking failed");
      await sendMessage("ยังไม่มีรูปในชุดสลิปนี้");
      messageSent = true;
      const { error: emptyErr } = await supabase.from("slip_batches").update({
        status:          "failed",
        finalized_at:    new Date().toISOString(),
        summary_sent_at: new Date().toISOString(),
      }).eq("id", batchId);
      if (emptyErr) {
        log.error("finalizeSlipBatch: DB update failed after empty-batch message", {
          reason: emptyErr.message,
        });
        return { delivered: true, persisted: false, persistError: emptyErr.message };
      }
      return { delivered: true, persisted: true };
    }

    const title    = buildSessionTitle(batchRow);
    const slipDate = parseBatchDate(batchRow?.slip_date ?? null);
    const message  = buildBatchSummaryMessage(evidences, {
      title,
      isTimeout: isTimeoutForced,
      slipDate,
    });

    await sendMessage(message);
    messageSent = true;

    // Derive counts from the same validation guard used by the summary.
    const validationFlags = computeValidationFlags(evidences, slipDate);
    const successCount = evidences.filter(
      (e, i) =>
        isVerifiedSlipCheckStatus(e.checkStatus) &&
        !validationFlags[i].flagged,
    ).length;
    const failedCount = evidences.length - successCount;
    const now = new Date().toISOString();

    const { error: updateError } = await supabase.from("slip_batches").update({
      status:          successCount === 0 ? "failed" : failedCount > 0 ? "review_needed" : "completed",
      success_count:   successCount,
      failed_count:    failedCount,
      finalized_at:    now,
      summary_sent_at: now,
    }).eq("id", batchId);

    if (updateError) {
      // LINE already delivered the summary but the DB update failed.
      // Return a structured failure so the caller can surface it correctly.
      // The batch stays in processing with summary_sent_at=null so a subsequent
      // recovery call can retry the DB update using the same batch-id retry key
      // (LINE will return 409 already_accepted; no duplicate message is sent).
      log.error("finalizeSlipBatch: DB update failed after LINE success — summary was sent", {
        reason: updateError.message,
      });
      return { delivered: true, persisted: false, persistError: updateError.message };
    }

    log.info("finalizeSlipBatch: batch finalized", {
      evidenceCount: evidences.length,
      successCount,
      failedCount,
      summaryTitle:  title ?? "default",
      isTimeoutForced,
    });

    const businessDate = bangkokBusinessDateFromTimestamp(
      new Date(batchRow?.closing_at ?? batchRow?.last_image_at ?? "").getTime(),
    );
    if (businessDate) {
      tryFinalizeSettlement(supabase, batchRow!.source_id, businessDate).catch(
        (err) => log.warn("tryFinalizeSettlement failed", { reason: err instanceof Error ? err.message : String(err) }),
      );
    }

    return { delivered: true, persisted: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error("finalizeSlipBatch: finalize failed", { reason, messageSent });

    if (!messageSent) {
      // Pre-send failure: do NOT revert to 'collecting'.
      // Reverting would re-open image collection on a closed batch, which must
      // never happen after finalization starts. The bounded stale-processing
      // recovery sweep will retry it later with the same LINE retry key.
      log.error(
        "finalizeSlipBatch: pre-send failure — batch stays in processing for stale recovery",
        { batchId },
      );
    }
    // Post-send failure (messageSent=true): summary was delivered.
    // The batch stays in 'processing'; the idempotency guard (summary_sent_at)
    // prevents duplicate sends on subsequent cron executions.
    throw err;
  }
}

async function loadBatchRow(supabase: Supabase, batchId: string): Promise<SlipBatchRow | null> {
  const { data } = await supabase
    .from("slip_batches")
    .select("*")
    .eq("id", batchId)
    .maybeSingle();
  return data ?? null;
}

async function loadBatchEvidences(
  supabase: Supabase,
  batchId: string,
): Promise<EvidenceWithCheck[]> {
  const { data: evidenceData, error: evidenceError } = await supabase
    .from("slip_evidences")
    .select("id, batch_index")
    .eq("batch_id", batchId)
    .order("batch_index", { ascending: true });

  if (evidenceError) throw new Error(`loadBatchEvidences evidence: ${evidenceError.message}`);

  const evidenceRows = evidenceData ?? [];
  if (evidenceRows.length === 0) return [];

  const evidenceIds = evidenceRows.map((e) => e.id);

  const { data: checkData, error: checkError } = await supabase
    .from("slip_checks")
    .select("id, evidence_id, status, slip_type, gross_amount, discount_amount, transfer_amount, paid_amount, transaction_time, reference_id, failure_reason")
    .in("evidence_id", evidenceIds);

  if (checkError) throw new Error(`loadBatchEvidences checks: ${checkError.message}`);

  const checkByEvidenceId = new Map<string, typeof checkData extends Array<infer T> ? T : never>();
  for (const check of checkData ?? []) {
    checkByEvidenceId.set(check.evidence_id, check);
  }

  return evidenceRows.map((ev) => {
    const check = checkByEvidenceId.get(ev.id);
    return {
      id:              ev.id,
      checkId:         check?.id ?? null,
      batchIndex:      ev.batch_index,
      checkStatus:     (check?.status ?? null) as SlipCheckStatus | null,
      slipType:        (check?.slip_type ?? null) as SlipType | null,
      grossAmount:     check?.gross_amount ?? null,
      discountAmount:  check?.discount_amount ?? null,
      transferAmount:  check?.transfer_amount ?? null,
      paidAmount:      check?.paid_amount ?? null,
      transactionTime: check?.transaction_time ?? null,
      referenceId:     check?.reference_id ?? null,
      failureReason:   check?.failure_reason ?? null,
    };
  });
}

/**
 * Read-time batch guard backed by the same global winner resolver used by
 * reconciliation. It does not claim uniqueness and therefore remains
 * best-effort until slip_checks.reference_id has an approved unique index.
 */
export async function applyGlobalDuplicateExclusions(
  supabase: Supabase,
  evidences: readonly EvidenceWithCheck[],
): Promise<EvidenceWithCheck[]> {
  const candidateReferences = [...new Set(
    evidences
      .filter((e) => e.checkId && isVerifiedSlipCheckStatus(e.checkStatus))
      .map((e) => normalizeTransactionId(e.referenceId))
      .filter((reference): reference is string => reference !== null),
  )];
  if (candidateReferences.length === 0) return evidences.map((e) => ({ ...e }));

  const acceptedCheckIds = await resolveGloballyAcceptedCheckIds(
    supabase,
    candidateReferences,
  );
  if (acceptedCheckIds.size === 0) return evidences.map((e) => ({ ...e }));

  return evidences.map((evidence) => {
    const reference = normalizeTransactionId(evidence.referenceId);
    return {
      ...evidence,
      globallyDuplicate:
        isVerifiedSlipCheckStatus(evidence.checkStatus)
        && reference !== null
        && evidence.checkId != null
        && !acceptedCheckIds.has(evidence.checkId),
    };
  });
}

function buildSessionTitle(batch: SlipBatchRow | null): string | undefined {
  if (!batch) return undefined;
  if (!batch.seller_name && !batch.market_name) return undefined;
  const parts = [batch.seller_name, batch.market_name, batch.slip_date].filter(Boolean);
  return `สรุปชุดสลิปเงินโอน ${parts.join(" — ")}`;
}

// Reasons that represent amount-level problems (not date-only).
// Only these count toward "ยอดที่ถูกระงับ"; date-only exclusions are not suspicious amounts.
const AMOUNT_FLAG_REASONS = new Set<ValidationReason>(["ยอดเงินสูงผิดปกติ", "สลิปซ้ำ", "ข้อมูลไม่ครบ"]);

/**
 * Builds the LINE summary message for a finalized batch.
 *
 * Applies two validation guards before computing the trusted total:
 *
 *   Outlier guard — flags an extracted amount when:
 *     • The batch has ≥ 5 valid extracted amounts, AND
 *     • The amount is ≥ 5,000 THB, AND
 *     • The amount is ≥ 10 × the batch median.
 *
 *   Date guard — flags an extracted item when its transaction date
 *     differs from slipDate by more than 1 calendar day (Bangkok time).
 *
 * Flagged items are moved to manual review and excluded from the trusted total.
 * GPT extraction data is never overwritten; the guard operates on display only.
 *
 * When isTimeout=true (max closing timeout reached), shows a detailed
 * per-category breakdown (completed / failed / manual-review / pending).
 */
export function buildBatchSummaryMessage(
  evidences: EvidenceWithCheck[],
  options?: { title?: string; isTimeout?: boolean; slipDate?: string | null },
): string {
  const total = evidences.length;
  if (total === 0) return "";

  const flags = computeValidationFlags(evidences, parseBatchDate(options?.slipDate ?? null));

  type Enriched = EvidenceWithCheck & { flags: EvidenceFlags };
  const enriched: Enriched[] = evidences.map((e, i) => ({ ...e, flags: flags[i] }));

  const trusted    = enriched.filter(
    (e) => isVerifiedSlipCheckStatus(e.checkStatus) && !e.flags.flagged,
  );
  const flagged    = enriched.filter(
    (e) => isVerifiedSlipCheckStatus(e.checkStatus) && e.flags.flagged,
  );
  const failedEvs  = enriched.filter((e) => e.checkStatus === "FAILED");
  const needReview = enriched.filter((e) => e.checkStatus === "NEED_REVIEW");
  const pending    = enriched.filter(
    (e) => e.checkStatus === null || e.checkStatus === "PROCESSING",
  );
  // Flagged completed items are treated as manual review.
  const incomplete = [...failedEvs, ...needReview, ...pending, ...flagged];

  const trustedTotal = trusted.reduce(
    (sum, e) => sum + (e.flags.effectiveAmount ?? 0),
    0,
  );

  // ── Timeout forced: detailed breakdown ──────────────────────────────────────
  if (options?.isTimeout && (pending.length > 0 || failedEvs.length > 0)) {
    const lines: string[] = [
      options.title ?? "สรุปรูปหลักฐานรอบนี้ (หมดเวลา)",
      `รับทั้งหมด: ${total} รูป`,
      `อ่านครบ: ${trusted.length} รูป`,
    ];
    if (failedEvs.length > 0)
      lines.push(`อ่านไม่สำเร็จ: ${failedEvs.length} รูป`);
    if ((needReview.length + flagged.length) > 0)
      lines.push(`รอตรวจมือ: ${needReview.length + flagged.length} รูป`);
    if (pending.length > 0)
      lines.push(`รอประมวลผล: ${pending.length} รูป`);
    if (trustedTotal > 0) {
      lines.push(
        `ยอดรวมที่อ่านได้: ${trustedTotal.toLocaleString("th-TH", { maximumFractionDigits: 2 })} บาท`,
      );
    }
    const amountFlaggedCountTimeout = flagged.filter(
      (e) => e.flags.flagReasons.some((r) => AMOUNT_FLAG_REASONS.has(r as ValidationReason)),
    ).length;
    if (amountFlaggedCountTimeout > 0) {
      lines.push(`ยอดที่ถูกระงับ: ${amountFlaggedCountTimeout} รายการ`);
    }
    appendTrustedEvidenceLines(lines, trusted);
    if (incomplete.length > 0) {
      lines.push("");
      lines.push("รูปที่ยังไม่ครบ:");
      for (const e of incomplete) {
        const idx = e.batchIndex ?? "?";
        lines.push(`#${idx} ${describeIncompleteReason(e)}`);
      }
    }
    return lines.join("\n");
  }

  // ── Normal (non-timeout) rendering ──────────────────────────────────────────
  if (trusted.length === 0 && flagged.length === 0) {
    if (options?.title) {
      return `${options.title}\n\nรับทั้งหมด: ${total} รูป แต่ระบบอ่านข้อมูลไม่ครบ กรุณาให้แอดมินตรวจมือ`;
    }
    return `รับรูปหลักฐานแล้วทั้งหมด ${total} รูป แต่ระบบอ่านข้อมูลไม่ครบ กรุณาให้แอดมินตรวจมือ`;
  }

  const lines: string[] = [
    options?.title ?? "สรุปรูปหลักฐานรอบนี้",
    `รับทั้งหมด: ${total} รูป`,
    `อ่านครบ: ${trusted.length} รูป`,
    `รอตรวจมือ: ${incomplete.length} รูป`,
  ];

  if (trustedTotal > 0) {
    lines.push(
      `ยอดรวมที่อ่านได้: ${trustedTotal.toLocaleString("th-TH", { maximumFractionDigits: 2 })} บาท`,
    );
  }
  const amountFlaggedCount = flagged.filter(
    (e) => e.flags.flagReasons.some((r) => AMOUNT_FLAG_REASONS.has(r as ValidationReason)),
  ).length;
  if (amountFlaggedCount > 0) {
    lines.push(`ยอดที่ถูกระงับ: ${amountFlaggedCount} รายการ`);
  }

  appendTrustedEvidenceLines(lines, trusted);

  if (incomplete.length > 0) {
    lines.push("");
    lines.push("รูปที่ต้องตรวจมือ:");
    for (const e of incomplete) {
      const idx = e.batchIndex ?? "?";
      lines.push(`#${idx} ${describeIncompleteReason(e)}`);
    }
  }

  return lines.join("\n");
}

type EnrichedEvidence = EvidenceWithCheck & { flags: EvidenceFlags };

function appendTrustedEvidenceLines(lines: string[], trusted: EnrichedEvidence[]): void {
  if (trusted.length === 0) return;
  lines.push("");
  lines.push("รูปที่ตรวจผ่าน:");
  for (const e of trusted) {
    const idx    = e.batchIndex ?? "?";
    const amount = e.flags.effectiveAmount;
    if (amount !== null && amount > 0) {
      const formatted = amount.toLocaleString("th-TH", { maximumFractionDigits: 2 });
      lines.push(`#${idx} เช็คได้ ${formatted} บาท`);
    } else {
      lines.push(`#${idx} เช็คได้`);
    }
  }
}

function describeIncompleteReason(e: EnrichedEvidence): string {
  if (e.flags.flagged && e.flags.flagReasons.length > 0) {
    return e.flags.flagReasons.join(", ");
  }
  return describeReviewReason(e);
}

function describeReviewReason(e: EvidenceWithCheck): string {
  if (e.checkStatus === "PROCESSING") return "รอผลการตรวจสอบ";
  if (e.checkStatus === null)         return "ยังไม่ได้ตรวจสอบ";
  if (e.checkStatus === "FAILED") {
    if (e.failureReason === "evidence_load_failed")     return "โหลดรูปไม่สำเร็จ";
    if (e.failureReason === "evidence_download_failed") return "ดาวน์โหลดรูปไม่สำเร็จ";
    if (e.failureReason === "extractor_not_configured") return "ระบบอ่านรูปไม่พร้อม";
    return "อ่านข้อมูลไม่ครบ";
  }
  if (e.checkStatus === "NEED_REVIEW") return "ไม่พบข้อมูลครบถ้วน";
  return "ยังไม่ได้ตรวจสอบ";
}
