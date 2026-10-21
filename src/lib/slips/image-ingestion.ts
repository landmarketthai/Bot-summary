import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { SLIP_INGEST_POLICY, attemptWorstCaseMs } from "@/lib/slips/ingest-policy";
import { withTimeout } from "@/lib/slips/io-timeout";
import type { SlipEvidenceIngestor } from "@/lib/slips/types";
import type { Database, LineSourceType } from "@/types/database";

type Supabase = SupabaseClient<Database>;

/**
 * Outcome of one attempt to move a received LINE image into its slip batch.
 *
 * Every outcome except `no_ledger` and `not_claimed` is durably recorded in
 * slip_image_events, so the caller can always acknowledge the queue event:
 * nothing is ever lost by acknowledging, and a failed image never blocks the
 * images behind it.
 */
export type SlipImageOutcome =
  | "attached"
  | "already_attached"
  | "retry_pending"
  | "failed_permanent"
  | "excluded_after_close"
  | "late_after_finalize"
  | "excluded_not_slip"
  /** Another worker owns the attempt, or it is not due yet. */
  | "not_claimed"
  /** Processed in LINE order and no slip session covers it: not a slip image. */
  | "no_session"
  /**
   * The ledger could not be read or written (timeout, network, malformed
   * reply). Nothing was decided: the caller must NOT acknowledge the queue
   * event and must NOT fall back to the legacy path.
   */
  | "unavailable"
  /** No ledger row (receipt predates the migration), or pre-migration DB. */
  | "no_ledger";

export interface SlipImageResult {
  outcome: SlipImageOutcome;
  batchId?: string;
  batchIndex?: number;
  evidenceId?: string;
  attempt?: number;
}

export interface SlipImageAccounting {
  batch_id: string;
  received_total: number;
  attached: number;
  waiting: number;
  retry_pending: number;
  queue_dead: number;
  failed_permanent: number;
  late_after_finalize: number;
  excluded_after_close: number;
  excluded_not_slip: number;
  ocr_complete: number;
  ocr_pending: number;
  incomplete: number;
  oldest_unresolved_age_seconds: number | null;
}

export interface SlipImageIngestionOptions {
  maxAttempts?: number;
  leaseSeconds?: number;
}

export const SLIP_IMAGE_MAX_ATTEMPTS = 5;
export const SLIP_IMAGE_LEASE_SECONDS = 120;

interface BeginResult {
  claimed: boolean;
  reason?: string;
  state?: string;
  raw_message_id?: string;
  batch_id?: string;
  source_id?: string;
  source_type?: string;
  line_user_id?: string | null;
  event_ts_ms?: number | string;
  attempt?: number;
}

interface AttachResult {
  outcome: string;
  batch_id?: string;
  batch_index?: number | null;
  evidence_id?: string;
}

/**
 * True ONLY when the ledger function is verifiably not deployed:
 *   - a PostgREST/Postgres error REPLY with code 42883 (undefined_function) or
 *     PGRST202 (function not found), or
 *   - a unit-test double that THROWS `unexpected rpc <name>` for an RPC it does
 *     not model, or a hand-written client with no rpc() (TypeError). Anchored:
 *     a real "Unexpected token ..." parse error or a network failure never
 *     matches.
 * Timeouts (57014), connection failures, malformed replies and every other
 * error are NOT missing-ledger and must never route an image to the legacy
 * path: the caller keeps the image pending and retries.
 */
export function isMissingLedger(error: unknown, thrown = false): boolean {
  if (error === null || typeof error !== "object") return false;
  const e = error as { code?: unknown };
  if (e.code === "42883" || e.code === "PGRST202") return true;
  if (!thrown) return false;
  if (!(error instanceof Error)) return false;
  return /^unexpected,?\s+(?:business\s+)?rpc\b/i.test(error.message)
    // A client object with no rpc() at all can only be a hand-written double.
    || (error instanceof TypeError && /\.rpc is not a function/.test(error.message));
}

/**
 * Runs `work` over `items` in list order with at most `lanes` in flight. A lane
 * stops (and no lane takes new items) once `work` returns false — the budget
 * check refused to start — so nothing is started after the time budget.
 */
async function runLanes<T>(items: T[], lanes: number, work: (item: T) => Promise<boolean>): Promise<void> {
  let next = 0;
  let stopped = false;
  const lane = async () => {
    while (!stopped && next < items.length) {
      if (!(await work(items[next++]))) stopped = true;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, items.length)) }, lane));
}

/**
 * Moves one ledgered LINE image through download -> storage -> batch
 * attachment -> OCR scheduling, with a durable lease, a bounded attempt
 * budget and exponential backoff. All state transitions happen in SQL RPCs;
 * this class only sequences them with the provider calls.
 */
export class SlipImageIngestionService {
  private readonly maxAttempts: number;
  private readonly leaseSeconds: number;

  constructor(
    private readonly supabase: Supabase,
    private readonly evidence: SlipEvidenceIngestor,
    private readonly scheduleOcr: (evidenceId: string) => void,
    options: SlipImageIngestionOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? SLIP_IMAGE_MAX_ATTEMPTS;
    this.leaseSeconds = options.leaseSeconds ?? SLIP_IMAGE_LEASE_SECONDS;
  }

  async process(lineMessageId: string): Promise<SlipImageResult> {
    const log = logger.child({ lineMessageId });

    let begin: BeginResult;
    try {
      const { data, error } = await this.supabase.rpc("begin_slip_image_attempt", {
        p_line_message_id: lineMessageId,
        p_max_attempts: this.maxAttempts,
        p_lease_seconds: this.leaseSeconds,
      });
      if (error) {
        if (isMissingLedger(error)) return { outcome: "no_ledger" };
        log.error("slip image ledger begin failed — image stays queued", { code: error.code });
        return { outcome: "unavailable" };
      }
      if (typeof (data as { claimed?: unknown } | null)?.claimed !== "boolean") {
        log.error("slip image ledger begin returned a malformed reply — image stays queued");
        return { outcome: "unavailable" };
      }
      begin = data as unknown as BeginResult;
    } catch (error) {
      if (isMissingLedger(error, true)) return { outcome: "no_ledger" };
      log.error("slip image ledger begin threw — image stays queued", {
        error: error instanceof Error ? error.name : "unknown",
      });
      return { outcome: "unavailable" };
    }

    if (!begin.claimed) return this.unclaimedResult(begin, log);

    const batchId = begin.batch_id!;
    try {
      let evidenceId: string | null = await this.findStoredEvidence(lineMessageId);

      if (!evidenceId) {
        const ingested = await this.evidence.ingest({
          rawMessageId: begin.raw_message_id!,
          lineMessageId,
          sourceId: begin.source_id!,
          sourceType: (begin.source_type ?? "user") as LineSourceType,
          lineUserId: begin.line_user_id ?? null,
          eventTimestamp: Number(begin.event_ts_ms),
        });
        if (ingested.status !== "RECEIVED" || !ingested.evidenceId) {
          const code = ingested.status === "DOWNLOAD_FAILED" ? "download_failed" : "storage_failed";
          return this.fail(lineMessageId, batchId, code, begin.attempt, log);
        }
        evidenceId = ingested.evidenceId;
      }

      const { data, error } = await this.supabase.rpc("attach_slip_image_event", {
        p_line_message_id: lineMessageId,
        p_evidence_id: evidenceId,
        p_attempt: begin.attempt!,
      });
      if (error) {
        return this.fail(lineMessageId, batchId, "attach_failed", begin.attempt, log);
      }
      const attach = data as unknown as AttachResult;
      if (attach.outcome === "stale_claim") {
        // Lease expired and a newer worker owns the row: this attempt is void.
        log.warn("slip image attach rejected: stale claim", { batchId, attempt: begin.attempt });
        return { outcome: "not_claimed", batchId, attempt: begin.attempt };
      }

      log.info("slip image ingestion outcome", {
        batchId,
        evidenceId,
        outcome: attach.outcome,
        batchIndex: attach.batch_index ?? null,
        attempt: begin.attempt,
      });

      if (attach.outcome === "attached") this.scheduleOcr(evidenceId);

      return {
        outcome: attach.outcome as SlipImageOutcome,
        batchId: attach.batch_id ?? batchId,
        batchIndex: attach.batch_index ?? undefined,
        evidenceId,
        attempt: begin.attempt,
      };
    } catch (error) {
      log.error("slip image ingestion attempt threw", {
        batchId,
        error: error instanceof Error ? error.name : "unknown",
      });
      return this.fail(lineMessageId, batchId, "attempt_exception", begin.attempt, log);
    }
  }

  /**
   * Re-drives ledger rows that are due (retry window passed, lease expired, ...).
   * The SQL list is fair (fewest attempts first), and `lanes` attempts run
   * concurrently, so a whole design-size burst gets one attempt per sweep
   * instead of the oldest few monopolising every sweep.
   */
  async recoverDue(
    limit: number = SLIP_INGEST_POLICY.cron.ingestListLimit,
    deadlineMs = Number.POSITIVE_INFINITY,
    lanes: number = SLIP_INGEST_POLICY.cron.ingestLanes,
  ): Promise<{
    due: number;
    attached: number;
    retryPending: number;
    failedPermanent: number;
    other: number;
    /** True when the due list could not be read (not the same as "nothing due"). */
    listFailed?: boolean;
  }> {
    const summary: {
      due: number; attached: number; retryPending: number; failedPermanent: number; other: number;
      listFailed?: boolean;
    } = { due: 0, attached: 0, retryPending: 0, failedPermanent: 0, other: 0 };
    const { data, error } = await this.supabase.rpc("list_due_slip_image_events", { p_limit: limit });
    if (error) {
      if (!isMissingLedger(error)) {
        logger.error("slip image due list failed", { code: error.code });
        summary.listFailed = true;
      }
      return summary;
    }
    const ids = (data ?? []) as string[];
    summary.due = ids.length;
    await runLanes(ids, lanes, async (id) => {
      // Never START an attempt that cannot finish inside the budget.
      if (deadlineMs - Date.now() < attemptWorstCaseMs()) return false;
      const result = await this.process(id);
      if (result.outcome === "attached" || result.outcome === "already_attached") summary.attached += 1;
      else if (result.outcome === "retry_pending") summary.retryPending += 1;
      else if (result.outcome === "failed_permanent") summary.failedPermanent += 1;
      else summary.other += 1;
      return true;
    });
    return summary;
  }

  /**
   * Re-runs OCR only for attached evidence whose check never started or is
   * stuck, `lanes` jobs at a time (SQL list is fair: least-claimed first).
   */
  async redriveOcr(
    run: (evidenceId: string) => Promise<void>,
    limit: number = SLIP_INGEST_POLICY.cron.ocrListLimit,
    deadlineMs = Number.POSITIVE_INFINITY,
    lanes: number = SLIP_INGEST_POLICY.cron.ocrLanes,
  ): Promise<number> {
    const { data, error } = await this.supabase.rpc("list_slip_ocr_redrive", { p_limit: limit });
    if (error) {
      if (!isMissingLedger(error)) {
        logger.error("slip ocr redrive list failed", { code: error.code });
      }
      return 0;
    }
    let count = 0;
    await runLanes((data ?? []) as string[], lanes, async (evidenceId) => {
      // An OCR job starts only if its whole hard cap still fits the budget; the
      // cap bounds a hanging provider (orphans are fenced by the check claim token).
      const jobMs = SLIP_INGEST_POLICY.io.ocrJobTimeoutMs;
      if (deadlineMs - Date.now() < jobMs) return false;
      try {
        await withTimeout("ocr_job", jobMs, () => run(evidenceId));
      } catch (error) {
        logger.error("slip ocr redrive job failed or timed out", {
          evidenceId,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
      count += 1;
      return true;
    });
    return count;
  }

  async accounting(batchId: string): Promise<SlipImageAccounting | null> {
    try {
      const { data, error } = await this.supabase.rpc("slip_batch_image_accounting", {
        p_batch_id: batchId,
      });
      if (error || !data) return null;
      return data as unknown as SlipImageAccounting;
    } catch {
      return null;
    }
  }

  async health(): Promise<Record<string, number | null> | null> {
    try {
      const { data, error } = await this.supabase.rpc("slip_image_ledger_health");
      if (error || !data) return null;
      return data as unknown as Record<string, number | null>;
    } catch {
      return null;
    }
  }

  private unclaimedResult(begin: BeginResult, log: ReturnType<typeof logger.child>): SlipImageResult {
    switch (begin.reason) {
      case "no_ledger":
        return { outcome: "no_ledger" };
      case "batch_finalized":
        log.warn("slip image arrived after its batch was finalized", { batchId: begin.batch_id });
        return { outcome: "late_after_finalize" };
      case "budget_exhausted":
        log.error("slip image attempt budget exhausted", { batchId: begin.batch_id });
        return { outcome: "failed_permanent" };
      case "resolved":
        if (begin.state === "attached") return { outcome: "already_attached" };
        if (begin.state === "failed_permanent") return { outcome: "failed_permanent" };
        if (begin.state === "excluded_after_close") return { outcome: "excluded_after_close" };
        if (begin.state === "excluded_not_slip") return { outcome: "excluded_not_slip" };
        if (begin.state === "late_after_finalize") return { outcome: "late_after_finalize" };
        if (begin.state === "no_session") return { outcome: "no_session" };
        return { outcome: "not_claimed" };
      default:
        return { outcome: "not_claimed" };
    }
  }

  private async findStoredEvidence(lineMessageId: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from("slip_evidences")
      .select("id, status")
      .eq("line_message_id", lineMessageId)
      .maybeSingle();
    // A failed lookup is not "no evidence": throw so the attempt is failed and
    // retried instead of re-downloading blindly.
    if (error) throw new Error("slip evidence lookup failed");
    return data && data.status === "RECEIVED" ? data.id : null;
  }

  private async fail(
    lineMessageId: string,
    batchId: string,
    code: string,
    attempt: number | undefined,
    log: ReturnType<typeof logger.child>,
  ): Promise<SlipImageResult> {
    const { data, error } = await this.supabase.rpc("fail_slip_image_event", {
      p_line_message_id: lineMessageId,
      p_error: code,
      p_attempt: attempt!,
      p_max_attempts: this.maxAttempts,
      p_permanent: false,
    });
    const outcome = error
      ? "retry_pending"
      : ((data as unknown as { outcome?: string })?.outcome ?? "retry_pending");
    log.warn("slip image attempt failed", { batchId, code, attempt, outcome });
    if (outcome === "stale_claim") return { outcome: "not_claimed", batchId, attempt };
    return {
      outcome: (outcome === "failed_permanent" ? "failed_permanent" : "retry_pending"),
      batchId,
      attempt,
    };
  }
}
