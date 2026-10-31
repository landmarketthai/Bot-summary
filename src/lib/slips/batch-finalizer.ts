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
import type { SlipImageAccounting } from "@/lib/slips/image-ingestion";
import { loadImageSequence, type ImageSequence, type MissingImage } from "@/lib/slips/image-sequence";
import { DEFAULT_INGEST_MAX_SECONDS, SLIP_INGEST_POLICY } from "@/lib/slips/ingest-policy";
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

// Upper bound on how long a closing batch waits for images that were received
// before the close command but are not yet ingested (download/store/retry).
// After this the batch is finalized and the summary states what is missing, so
// an irrecoverable image can never block a batch forever. Derived from the
// ingest policy so all 5 attempts fit under the real scheduler (GitHub Actions
// every 5 min, tolerated lateness included); see src/lib/slips/ingest-policy.ts.
export const CLOSE_INGEST_MAX_SECONDS = parseCloseSeconds(
  process.env.SLIP_CLOSE_INGEST_MAX_SECONDS,
  DEFAULT_INGEST_MAX_SECONDS,
);

// A batch that has stayed in processing beyond two normal request windows is
// treated as stranded and becomes eligible for bounded automatic recovery.
const PROCESSING_RECOVERY_STALE_MINUTES = 2;
const PROCESSING_RECOVERY_LIMIT = 20;
const LINE_RETRY_KEY_WINDOW_HOURS = 24;

/**
 * Time a single batch finalization normally needs (one LINE push at its cap +
 * a few DB round trips). Finalizers given a deadline do not CLAIM/lease a batch
 * with less than this left; a batch already claimed when the deadline cuts its
 * I/O stays in processing for the stale sweep, which retries with the same
 * LINE retry key (no duplicate summary).
 */
export const FINALIZE_BATCH_RESERVE_MS = SLIP_INGEST_POLICY.functions.linePushTimeoutMs + 4_000;

const hasTimeFor = (deadlineMs: number) => deadlineMs - Date.now() >= FINALIZE_BATCH_RESERVE_MS;

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
  lineMessageId?:  string | null;
  /** Attach-completion counter; NOT the LINE send order. */
  batchIndex:      number | null;
  /**
   * Position in LINE send order (image-sequence.ts); null when the ledger has
   * no verified place for it. Undefined = no ledger, #N falls back to batchIndex.
   */
  sequence?:       number | null;
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
  deadlineMs: number = Number.POSITIVE_INFINITY,
): Promise<number> {
  if (!hasTimeFor(deadlineMs)) return 0;
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
  // Abandoned batches skip claim_closing_slip_batch (no ledger reconciliation
  // there), so finalizeSlipBatch's own accounting is the only gate: in-flight or
  // failed images are reported as incomplete (review_needed + notice, never
  // "completed"), and an accounting failure leaves the batch in processing for
  // the stale-processing sweep. One failing batch must not block the others.
  for (const batch of batches) {
    if (!hasTimeFor(deadlineMs)) {
      logger.warn("finalize-slip-batches: out of time — abandoned batch left in processing for recovery", { batchId: batch.id });
      continue;
    }
    try {
      await finalizeSlipBatch(
        supabase,
        batch.id,
        (text) => push(batch.source_id, text, batch.id),
        boundedSettlement(deadlineMs, push),
      );
    } catch (err) {
      logger.error("finalize-slip-batches: abandoned batch finalize failed — left in processing for recovery", {
        batchId: batch.id,
        reason: err instanceof Error ? err.message : String(err),
        accountingUnavailable: err instanceof SlipAccountingUnavailableError,
      });
    }
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
  ingestMaxSeconds?: number,
) => Promise<ClaimResult | null>;

async function defaultAtomicClaim(
  supabase:     Supabase,
  batchId:      string,
  quietSeconds: number,
  maxSeconds:   number,
  ingestMaxSeconds: number = CLOSE_INGEST_MAX_SECONDS,
): Promise<ClaimResult | null> {
  let { data, error } = await supabase.rpc("claim_closing_slip_batch", {
    p_batch_id:      batchId,
    p_quiet_seconds: quietSeconds,
    p_max_seconds:   maxSeconds,
    p_ingest_max_seconds: ingestMaxSeconds,
  });

  // Code deployed before the ledger migration: the 3-argument function is
  // still installed, so retry with its signature instead of never finalizing.
  if (error && (error.code === "PGRST202" || error.code === "42883")) {
    ({ data, error } = await supabase.rpc("claim_closing_slip_batch", {
      p_batch_id:      batchId,
      p_quiet_seconds: quietSeconds,
      p_max_seconds:   maxSeconds,
    } as never));
  }

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
  options?:    FinalizeOptions,
) => Promise<FinalizeResult | void>;

export interface FinalizeOptions {
  isTimeoutForced?: boolean;
  /**
   * Run the follow-up settlement finalization INSIDE this call with this
   * (time-bounded) push, instead of the default fire-and-forget with an
   * unbounded push. Set by deadline-bound callers (cron) so no settlement work
   * or LINE push runs detached past their deadline.
   */
  settlementPush?: PushMessage;
}

/** Deadline-bound callers await settlement with their bounded push. */
const boundedSettlement = (deadlineMs: number, push: PushMessage): FinalizeOptions | undefined =>
  Number.isFinite(deadlineMs) ? { settlementPush: push } : undefined;

export async function finalizeClosingSlipBatches(
  supabase:     Supabase,
  push:         PushMessage = defaultPush,
  quietSeconds: number = CLOSE_QUIET_SECONDS,
  maxSeconds:   number = CLOSE_MAX_SECONDS,
  _finalize:    FinalizeFn = finalizeSlipBatch,
  _claim:       ClaimFn = defaultAtomicClaim,
  ingestMaxSeconds: number = CLOSE_INGEST_MAX_SECONDS,
  deadlineMs: number = Number.POSITIVE_INFINITY,
): Promise<number> {
  if (!hasTimeFor(deadlineMs)) return 0;
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
    // Never claim (closing -> processing) what this run has no time to finish;
    // an unclaimed batch simply stays closing for the next sweep.
    if (!hasTimeFor(deadlineMs)) break;
    const claimed = await _claim(supabase, batch.id, quietSeconds, maxSeconds, ingestMaxSeconds);
    if (!claimed) continue;

    try {
      await _finalize(
        supabase,
        claimed.id,
        (text) => push(claimed.source_id, text, claimed.id),
        { isTimeoutForced: claimed.wasTimeout, ...boundedSettlement(deadlineMs, push) },
      );
      count++;
    } catch (err) {
      // Claimed batch is already 'processing'; the stale-processing sweep owns
      // the retry. One failing batch (e.g. accounting unavailable) must not
      // block the remaining closing batches in this run.
      logger.error("finalizeClosingSlipBatches: finalize failed — batch left in processing for recovery", {
        batchId: claimed.id,
        reason: err instanceof Error ? err.message : String(err),
        accountingUnavailable: err instanceof SlipAccountingUnavailableError,
      });
    }
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
  /**
   * Of `failed`: batches whose ledger accounting could not be established
   * (nothing was sent, batch stays processing and is retried every sweep until
   * the 24h retry-key window closes, then requires manual review).
   */
  accountingUnavailable?: number;
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
  routeDeadlineMs: number = Number.POSITIVE_INFINITY,
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
  // Own cap of 15 s, and never lease a batch the caller's deadline leaves no
  // time to finish (see FINALIZE_BATCH_RESERVE_MS).
  const deadlineMs = Math.min(Date.now() + 15_000, routeDeadlineMs - FINALIZE_BATCH_RESERVE_MS);

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
        boundedSettlement(routeDeadlineMs, push),
      );
      if (result && !result.persisted) run.failed += 1;
      else run.recovered += 1;
    } catch (recoveryError) {
      const reason = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      if (recoveryError instanceof SlipAccountingUnavailableError) {
        run.accountingUnavailable = (run.accountingUnavailable ?? 0) + 1;
        logger.error("recover-stale-slip-batches: ledger accounting unavailable — nothing sent, will retry", {
          batchId: batch.id,
          reason,
        });
      }
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
  options?:    FinalizeOptions,
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
    let evidences = await applyGlobalDuplicateExclusions(supabase, loadedEvidences);

    // Idempotency guard: if summary_sent_at is already set, another worker
    // (or a previous retry) already delivered the summary — skip silently.
    if (batchRow?.summary_sent_at) {
      log.warn("finalizeSlipBatch: summary already sent — skipping", {
        summarySetAt: batchRow.summary_sent_at,
      });
      return;
    }

    // Throws on RPC error/exception (fail closed, pre-send): nothing is sent
    // and the batch stays in processing for the next recovery sweep.
    const imageAccounting = await loadImageAccounting(supabase, batchId, batchRow);

    // #N must be the LINE send position, and the validation guard (first
    // occurrence of a duplicate stays trusted) must see images in that order.
    let sequence: ImageSequence | null = null;
    if (imageAccounting) {
      try {
        sequence = await loadImageSequence(
          supabase,
          batchId,
          new Set(evidences.flatMap((e) => (e.lineMessageId ? [e.lineMessageId] : []))),
        );
      } catch (thrown) {
        throw new SlipAccountingUnavailableError(
          `slip image sequence unavailable: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
        );
      }
      evidences = orderByLineSequence(evidences, sequence);
    }

    log.info("finalizing active slip batch", {
      evidenceCount: evidences.length,
      isTimeoutForced,
      imageAccounting,
    });

    if (evidences.length === 0) {
      log.warn("finalizeSlipBatch: no evidences — marking failed");
      const lostNotice = buildImageAccountingNotice(imageAccounting);
      await sendMessage(
        lostNotice
          ? `สรุปชุดสลิป: รับรูปจาก LINE แต่บันทึกเข้าชุดไม่สำเร็จ\n\n${lostNotice}`
          : "ยังไม่มีรูปในชุดสลิปนี้",
      );
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
    const baseMessage  = buildBatchSummaryMessage(evidences, {
      title,
      isTimeout: isTimeoutForced,
      slipDate,
      missingImages: sequence?.missing,
      sequenceUncertain: sequence === null || sequence.uncertain,
    });
    // Images received from LINE but missing from the batch are reported
    // explicitly; the partial total is never presented as the complete amount.
    const accountingNotice = buildImageAccountingNotice(imageAccounting);
    const message = accountingNotice ? `${baseMessage}\n\n${accountingNotice}` : baseMessage;

    await sendMessage(message);
    messageSent = true;

    // Derive counts from the same validation guard used by the summary.
    const validationFlags = computeValidationFlags(evidences, slipDate);
    const successCount = evidences.filter(
      (e, i) =>
        isVerifiedSlipCheckStatus(e.checkStatus) &&
        !validationFlags[i].flagged,
    ).length;
    const missingImages = imageAccounting?.incomplete ?? 0;
    const failedCount = evidences.length - successCount + missingImages;
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
      missingImages,
    });

    const businessDate = bangkokBusinessDateFromTimestamp(
      new Date(batchRow?.closing_at ?? batchRow?.last_image_at ?? "").getTime(),
    );
    if (businessDate) {
      const settled = (options?.settlementPush
        ? tryFinalizeSettlement(supabase, batchRow!.source_id, businessDate, options.settlementPush)
        : tryFinalizeSettlement(supabase, batchRow!.source_id, businessDate)
      ).catch(
        (err) => log.warn("tryFinalizeSettlement failed", { reason: err instanceof Error ? err.message : String(err) }),
      );
      if (options?.settlementPush) await settled;
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

/**
 * The ledger accounting could not be established. finalizeSlipBatch throws this
 * BEFORE sending anything or writing a terminal status, so the batch stays in
 * processing and the stale-processing sweep retries it (within the 24h window).
 */
export class SlipAccountingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlipAccountingUnavailableError";
  }
}

// PostgREST "function not in schema cache" / Postgres undefined_function: the
// only signals that the ledger migration is verifiably not deployed.
const LEDGER_FUNCTION_MISSING_CODES = new Set(["PGRST202", "42883"]);

/**
 * Ledger accounting for the batch. Returns null ONLY when the ledger migration
 * is verifiably absent (explicit legacy pre-migration path) or the batch has no
 * receipts. Any other RPC error, thrown exception or malformed payload throws:
 * the caller must not send a summary or mark the batch complete from partial
 * totals, and the batch stays in processing for the next recovery sweep.
 */
async function loadImageAccounting(
  supabase: Supabase,
  batchId: string,
  batchRow: SlipBatchRow | null,
): Promise<SlipImageAccounting | null> {
  let data: unknown;
  let error: { code?: string; message: string } | null;
  try {
    ({ data, error } = await supabase.rpc("slip_batch_image_accounting", { p_batch_id: batchId }));
  } catch (thrown) {
    throw new SlipAccountingUnavailableError(
      `slip image accounting unavailable (threw): ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }
  if (error) {
    // On a migrated schema even a missing RPC (e.g. stale PostgREST cache) is
    // NOT proof of completeness. Legacy fallback is permitted only when the
    // batch row itself lacks the ledger-era schema column.
    if (error.code && LEDGER_FUNCTION_MISSING_CODES.has(error.code)
        && batchRow && !Object.prototype.hasOwnProperty.call(batchRow, "open_event_ts_ms")) return null;
    throw new SlipAccountingUnavailableError(`slip image accounting unavailable (${error.code ?? "unknown"}): ${error.message}`);
  }
  const accounting = data as unknown as SlipImageAccounting | null;
  const counters = ["received_total", "attached", "waiting", "queue_dead", "failed_permanent", "late_after_finalize", "incomplete"] as const;
  if (
    !accounting
    || typeof accounting !== "object"
    || counters.some((k) => typeof accounting[k] !== "number" || !Number.isFinite(accounting[k]) || accounting[k] < 0)
  ) {
    throw new SlipAccountingUnavailableError("slip image accounting unavailable: malformed RPC payload");
  }
  return accounting.received_total > 0 ? accounting : null;
}

/**
 * Notice appended to the LINE summary when any received image is not in the
 * batch. Returns null when every received image is accounted for.
 */
export function buildImageAccountingNotice(
  accounting: SlipImageAccounting | null,
): string | null {
  if (!accounting || accounting.incomplete <= 0) return null;
  const lines = [
    "⚠️ ยอดนี้ยังไม่ครบ ห้ามใช้เป็นยอดรวมทั้งหมด",
    `รับรูปจาก LINE: ${accounting.received_total} รูป`,
    `เข้าชุดแล้ว: ${accounting.attached} รูป`,
    `ยังไม่ครบ: ${accounting.incomplete} รูป (ส่งใหม่หรือให้แอดมินตรวจมือ)`,
  ];
  const failed = accounting.failed_permanent + accounting.queue_dead;
  if (failed > 0) lines.push(`- ประมวลผลไม่สำเร็จ: ${failed} รูป`);
  if (accounting.waiting > 0) lines.push(`- ยังประมวลผลไม่เสร็จ: ${accounting.waiting} รูป`);
  if (accounting.late_after_finalize > 0) lines.push(`- มาถึงหลังสรุปชุด: ${accounting.late_after_finalize} รูป`);
  return lines.join("\n");
}

async function loadBatchRow(supabase: Supabase, batchId: string): Promise<SlipBatchRow | null> {
  const { data, error } = await supabase
    .from("slip_batches")
    .select("*")
    .eq("id", batchId)
    .maybeSingle();
  // A read error must not look like "no batch row": the legacy-schema decision
  // and the summary_sent_at idempotency guard both depend on this row.
  if (error) throw new Error(`loadBatchRow: ${error.message}`);
  return data ?? null;
}

async function loadBatchEvidences(
  supabase: Supabase,
  batchId: string,
): Promise<EvidenceWithCheck[]> {
  const { data: evidenceData, error: evidenceError } = await supabase
    .from("slip_evidences")
    .select("id, batch_index, line_message_id")
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
      lineMessageId:   ev.line_message_id ?? null,
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

/**
 * Puts evidences in LINE send order and stamps each with its #N. An evidence
 * the ledger cannot place gets sequence null (rendered "#?"), never a guess.
 */
export function orderByLineSequence(
  evidences: readonly EvidenceWithCheck[],
  sequence: ImageSequence,
): EvidenceWithCheck[] {
  return evidences
    .map((e) => ({ ...e, sequence: (e.lineMessageId && sequence.positions.get(e.lineMessageId)) || null }))
    .sort((a, b) =>
      (a.sequence ?? Infinity) - (b.sequence ?? Infinity)
      || (a.batchIndex ?? Infinity) - (b.batchIndex ?? Infinity));
}

/** #N label: LINE position when the ledger ordered the batch, else the legacy counter. */
const displayNumber = (e: EvidenceWithCheck): number | null =>
  e.sequence === undefined ? e.batchIndex : e.sequence;

const MISSING_IMAGE_REASON: Record<string, string> = {
  failed_permanent:    "รูปเข้าระบบไม่สำเร็จ",
  late_after_finalize: "รูปมาถึงหลังสรุปชุด",
};

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
  options?: {
    title?: string;
    isTimeout?: boolean;
    slipDate?: string | null;
    /** Received images with no evidence in the batch; they keep their #N. */
    missingImages?: readonly MissingImage[];
    /** #N could not be verified against LINE order for every image. */
    sequenceUncertain?: boolean;
  },
): string {
  if (evidences.length === 0) return "";
  const missing = options?.missingImages ?? [];
  const total = evidences.length + missing.length;

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
  if (options?.isTimeout && (pending.length > 0 || failedEvs.length > 0 || missing.length > 0)) {
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
    if (missing.length > 0)
      lines.push(`ยังไม่เข้าระบบ: ${missing.length} รูป`);
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
    appendIncompleteLines(lines, "รูปที่ยังไม่ครบ:", incomplete, missing);
    appendSequenceNote(lines, options?.sequenceUncertain);
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
    `รอตรวจมือ: ${incomplete.length + missing.length} รูป`,
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
  appendIncompleteLines(lines, "รูปที่ต้องตรวจมือ:", incomplete, missing);
  appendSequenceNote(lines, options?.sequenceUncertain);

  return lines.join("\n");
}

type EnrichedEvidence = EvidenceWithCheck & { flags: EvidenceFlags };

/** One line per image needing review, in #N order; missing images keep their number. */
function appendIncompleteLines(
  lines: string[],
  header: string,
  incomplete: EnrichedEvidence[],
  missing: readonly MissingImage[],
): void {
  const items = [
    ...incomplete.map((e) => ({ no: displayNumber(e), text: describeIncompleteReason(e) })),
    ...missing.map((m) => ({ no: m.sequence, text: MISSING_IMAGE_REASON[m.state] ?? "รูปยังไม่เข้าระบบ" })),
  ].sort((a, b) => (a.no ?? Infinity) - (b.no ?? Infinity));
  if (items.length === 0) return;
  lines.push("");
  lines.push(header);
  for (const item of items) lines.push(`#${item.no ?? "?"} ${item.text}`);
}

function appendSequenceNote(lines: string[], uncertain: boolean | undefined): void {
  if (!uncertain) return;
  lines.push("");
  lines.push("⚠️ เลข # บางรูปยืนยันลำดับจาก LINE ไม่ได้ ให้เทียบเวลาในแชทก่อนใช้");
}

function appendTrustedEvidenceLines(lines: string[], trusted: EnrichedEvidence[]): void {
  if (trusted.length === 0) return;
  lines.push("");
  lines.push("รูปที่ตรวจผ่าน:");
  for (const e of trusted) {
    const idx    = displayNumber(e) ?? "?";
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
