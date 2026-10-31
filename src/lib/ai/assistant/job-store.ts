/**
 * Durable @Botsummary answer jobs (supabase/migrations/20261031090000_ai_assistant_jobs.sql).
 *
 * Every state change is an RPC whose SQL enforces idempotency, leases, the
 * concurrency cap and lease-token fencing; this adapter only maps arguments.
 * Errors carry the PostgREST/PostgreSQL code, never row contents.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";

type Supabase = SupabaseClient<Database>;

export type AssistantJob = Database["public"]["Tables"]["ai_assistant_jobs"]["Row"];
export type AssistantDeliveryState = AssistantJob["delivery_state"];

export interface AssistantJobRequest {
  lineEventId: string;
  rawMessageId: string | null;
  destination: string;
  sourceType: "user" | "group" | "room";
  sourceId: string;
  lineUserId: string;
  question: string;
  /** Bangkok business date (YYYY-MM-DD) of the LINE event. */
  askedBusinessDate: string;
  eventTimestampMs: number;
  replyToken: string | null;
  /** ISO time after which the single-use reply token is not attempted. */
  replyTokenExpiresAt: string | null;
  maxAttempts?: number;
}

export type EnqueueOutcome = {
  outcome: "queued" | "duplicate" | "rate_limited" | "queue_full";
  jobId: string | null;
};

export interface ClaimOptions {
  limit: number;
  leaseSeconds: number;
  /** Cap on live leases across every worker invocation. */
  maxRunning: number;
}

export interface ConversationKey {
  destination: string;
  sourceId: string;
  lineUserId: string;
}

export interface ConversationTurn {
  question: string;
  answer: string;
  businessDate: string;
  context: Record<string, unknown>;
  eventTimestampMs: number;
}

export interface RecordAnswerInput {
  answer: string;
  kind: "answer" | "notice";
  usage?: Record<string, unknown> | null;
  toolNames?: readonly string[];
  /** Stored as a conversation turn only for kind "answer". */
  turn?: { businessDate: string; context: Record<string, unknown> } | null;
  turnTtlSeconds?: number;
  maxTurns?: number;
  /** Access scope the answer was produced under; required for kind "answer". */
  scopeKey?: string | null;
  /** "private" = 1:1 to the asker instead of the chat the question came from. */
  deliveryTarget?: "chat" | "private";
}

export interface AssistantJobStore {
  enqueue(request: AssistantJobRequest, limits?: { maxOutstandingPerConversation?: number; maxBacklog?: number }): Promise<EnqueueOutcome>;
  claim(workerId: string, options: ClaimOptions): Promise<AssistantJob[]>;
  recordAnswer(jobId: string, leaseToken: string, input: RecordAnswerInput): Promise<boolean>;
  setDelivery(
    jobId: string,
    leaseToken: string,
    from: readonly AssistantDeliveryState[],
    to: AssistantDeliveryState,
    channel?: "reply" | "push",
  ): Promise<boolean>;
  complete(jobId: string, leaseToken: string, status: "completed" | "failed", errorCode?: string | null): Promise<boolean>;
  retry(jobId: string, leaseToken: string, delaySeconds: number, errorCode: string): Promise<boolean>;
  /**
   * Earlier turns of the conversation produced under `scopeKey`, oldest
   * first, excluding `excludeJobId` itself.
   */
  loadTurns(key: ConversationKey, beforeEventMs: number, excludeJobId: string, scopeKey: string, limit: number): Promise<ConversationTurn[]>;
  /** Replace a recorded answer with a notice and forget its turn (scope changed). */
  withholdAnswer(jobId: string, leaseToken: string, notice: string): Promise<boolean>;
}

export class AssistantStoreError extends Error {
  constructor(readonly operation: string, readonly code: string | null) {
    super(`ai assistant store ${operation} failed${code ? ` (${code})` : ""}`);
    this.name = "AssistantStoreError";
  }
}

function fail(operation: string, error: { code?: string } | null): never {
  throw new AssistantStoreError(operation, error?.code ?? null);
}

export class SupabaseAssistantJobStore implements AssistantJobStore {
  constructor(private readonly supabase: Supabase) {}

  async enqueue(
    request: AssistantJobRequest,
    limits: { maxOutstandingPerConversation?: number; maxBacklog?: number } = {},
  ): Promise<EnqueueOutcome> {
    const { data, error } = await this.supabase.rpc("enqueue_ai_assistant_job", {
      p_job: {
        line_event_id: request.lineEventId,
        raw_message_id: request.rawMessageId,
        destination: request.destination,
        source_type: request.sourceType,
        source_id: request.sourceId,
        line_user_id: request.lineUserId,
        question: request.question,
        asked_business_date: request.askedBusinessDate,
        event_timestamp_ms: request.eventTimestampMs,
        reply_token: request.replyToken,
        reply_token_expires_at: request.replyTokenExpiresAt,
        max_attempts: request.maxAttempts ?? 3,
      },
      p_max_outstanding_per_conversation: limits.maxOutstandingPerConversation ?? 3,
      p_max_backlog: limits.maxBacklog ?? 500,
    });
    if (error) fail("enqueue", error);
    const row = data as { outcome?: unknown; job_id?: unknown } | null;
    const outcome = row?.outcome;
    if (outcome !== "queued" && outcome !== "duplicate" && outcome !== "rate_limited" && outcome !== "queue_full") {
      fail("enqueue", { code: "unexpected_result" });
    }
    return { outcome, jobId: typeof row?.job_id === "string" ? row.job_id : null };
  }

  async claim(workerId: string, options: ClaimOptions): Promise<AssistantJob[]> {
    const { data, error } = await this.supabase.rpc("claim_ai_assistant_jobs", {
      p_worker_id: workerId,
      p_limit: options.limit,
      p_lease_seconds: options.leaseSeconds,
      p_max_running: options.maxRunning,
    });
    if (error) fail("claim", error);
    return (data ?? []) as AssistantJob[];
  }

  async recordAnswer(jobId: string, leaseToken: string, input: RecordAnswerInput): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("record_ai_assistant_answer", {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_answer: input.answer,
      p_kind: input.kind,
      p_usage: (input.usage ?? null) as Json,
      p_tool_names: [...(input.toolNames ?? [])],
      p_turn_context: input.kind === "answer" && input.turn
        ? { business_date: input.turn.businessDate, context: input.turn.context } as Json
        : null,
      p_turn_ttl_seconds: input.turnTtlSeconds ?? 1800,
      p_max_turns: input.maxTurns ?? 6,
      p_scope_key: input.scopeKey ?? null,
      p_delivery_target: input.deliveryTarget ?? "chat",
    });
    if (error) fail("record_answer", error);
    return data === true;
  }

  async withholdAnswer(jobId: string, leaseToken: string, notice: string): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("withhold_ai_assistant_answer", {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_notice: notice,
    });
    if (error) fail("withhold_answer", error);
    return data === true;
  }

  async setDelivery(
    jobId: string,
    leaseToken: string,
    from: readonly AssistantDeliveryState[],
    to: AssistantDeliveryState,
    channel?: "reply" | "push",
  ): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("set_ai_assistant_delivery", {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_from: [...from],
      p_to: to,
      p_channel: channel ?? null,
    });
    if (error) fail("set_delivery", error);
    return data === true;
  }

  async complete(
    jobId: string,
    leaseToken: string,
    status: "completed" | "failed",
    errorCode: string | null = null,
  ): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("complete_ai_assistant_job", {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_status: status,
      p_error_code: errorCode,
    });
    if (error) fail("complete", error);
    return data === true;
  }

  async retry(jobId: string, leaseToken: string, delaySeconds: number, errorCode: string): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("retry_ai_assistant_job", {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_delay_seconds: Math.max(0, Math.round(delaySeconds)),
      p_error_code: errorCode,
    });
    if (error) fail("retry", error);
    return data === true;
  }

  async loadTurns(
    key: ConversationKey,
    beforeEventMs: number,
    excludeJobId: string,
    scopeKey: string,
    limit: number,
  ): Promise<ConversationTurn[]> {
    const { data, error } = await this.supabase.rpc("load_ai_assistant_turns", {
      p_destination: key.destination,
      p_source_id: key.sourceId,
      p_line_user_id: key.lineUserId,
      p_before_event_ms: beforeEventMs,
      p_exclude_job_id: excludeJobId,
      p_scope_key: scopeKey,
      p_limit: limit,
    });
    if (error) fail("load_turns", error);
    return ((data ?? []) as Array<{
      question: string;
      answer: string;
      business_date: string;
      context: unknown;
      event_timestamp_ms: number | string;
    }>).map((row) => ({
      question: row.question,
      answer: row.answer,
      businessDate: row.business_date,
      context: typeof row.context === "object" && row.context !== null && !Array.isArray(row.context)
        ? row.context as Record<string, unknown>
        : {},
      eventTimestampMs: Number(row.event_timestamp_ms),
    })).reverse();
  }
}
