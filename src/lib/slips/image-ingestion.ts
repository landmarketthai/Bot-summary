import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
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
  /** No ledger row: image arrived with no open slip batch, or pre-migration DB. */
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

/** True when the ledger RPCs are not deployed (pre-migration DB, unit doubles). */
function isMissingLedger(error: { code?: string; message?: string } | unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  const message = e?.message ?? (error instanceof Error ? error.message : String(error));
  return e?.code === "42883"
    || e?.code === "PGRST202"
    || /schema cache|does not exist|unexpected(?: .*?)?rpc/i.test(message);
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
        if (!isMissingLedger(error)) {
          log.error("slip image ledger begin failed — using legacy path", { code: error.code });
        }
        return { outcome: "no_ledger" };
      }
      begin = (data ?? { claimed: false, reason: "no_ledger" }) as unknown as BeginResult;
    } catch (error) {
      if (!isMissingLedger(error)) {
        log.error("slip image ledger begin threw — using legacy path");
      }
      return { outcome: "no_ledger" };
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
      });
      if (error) {
        return this.fail(lineMessageId, batchId, "attach_failed", begin.attempt, log);
      }
      const attach = data as unknown as AttachResult;

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

  /** Re-drives ledger rows that are due (retry window passed, lease expired, ...). */
  async recoverDue(limit = 10, deadlineMs = Number.POSITIVE_INFINITY): Promise<{
    due: number;
    attached: number;
    retryPending: number;
    failedPermanent: number;
    other: number;
  }> {
    const summary = { due: 0, attached: 0, retryPending: 0, failedPermanent: 0, other: 0 };
    const { data, error } = await this.supabase.rpc("list_due_slip_image_events", { p_limit: limit });
    if (error) {
      if (!isMissingLedger(error)) {
        logger.error("slip image due list failed", { code: error.code });
      }
      return summary;
    }
    const ids = (data ?? []) as string[];
    summary.due = ids.length;
    for (const id of ids) {
      if (Date.now() >= deadlineMs) break;
      const result = await this.process(id);
      if (result.outcome === "attached" || result.outcome === "already_attached") summary.attached += 1;
      else if (result.outcome === "retry_pending") summary.retryPending += 1;
      else if (result.outcome === "failed_permanent") summary.failedPermanent += 1;
      else summary.other += 1;
    }
    return summary;
  }

  /** Re-runs OCR only for attached evidence whose check never started or is stuck. */
  async redriveOcr(
    run: (evidenceId: string) => Promise<void>,
    limit = 10,
    deadlineMs = Number.POSITIVE_INFINITY,
  ): Promise<number> {
    const { data, error } = await this.supabase.rpc("list_slip_ocr_redrive", { p_limit: limit });
    if (error) {
      if (!isMissingLedger(error)) {
        logger.error("slip ocr redrive list failed", { code: error.code });
      }
      return 0;
    }
    let count = 0;
    for (const evidenceId of (data ?? []) as string[]) {
      if (Date.now() >= deadlineMs) break;
      await run(evidenceId);
      count += 1;
    }
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
        return { outcome: "not_claimed" };
      default:
        return { outcome: "not_claimed" };
    }
  }

  private async findStoredEvidence(lineMessageId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from("slip_evidences")
      .select("id, status")
      .eq("line_message_id", lineMessageId)
      .maybeSingle();
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
      p_max_attempts: this.maxAttempts,
      p_permanent: false,
    });
    const outcome = error
      ? "retry_pending"
      : ((data as unknown as { outcome?: string })?.outcome ?? "retry_pending");
    log.warn("slip image attempt failed", { batchId, code, attempt, outcome });
    return {
      outcome: (outcome === "failed_permanent" ? "failed_permanent" : "retry_pending"),
      batchId,
      attempt,
    };
  }
}
