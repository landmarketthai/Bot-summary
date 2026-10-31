/**
 * Test-only in-memory AssistantJobStore with the same semantics as the SQL
 * RPCs in 20261031090000_ai_assistant_jobs.sql. job-store.contract.ts runs
 * one scenario suite against this and against real PostgreSQL, so the two
 * cannot silently drift. Never imported by application code.
 */
import { randomUUID } from "node:crypto";
import type {
  AssistantDeliveryState,
  AssistantJob,
  AssistantJobRequest,
  AssistantJobStore,
  ClaimOptions,
  ConversationKey,
  ConversationTurn,
  EnqueueOutcome,
  RecordAnswerInput,
} from "../job-store";

type StoredTurn = ConversationTurn & ConversationKey & { jobId: string; expiresAt: number; id: number };

export class MemoryAssistantJobStore implements AssistantJobStore {
  readonly jobs = new Map<string, AssistantJob>();
  readonly turns: StoredTurn[] = [];
  private turnId = 0;
  /** Test clock offset (ms) for lease / backoff / TTL scenarios. */
  clockOffsetMs = 0;
  /** Inject a failure for the next call of an operation. */
  failNext: Partial<Record<keyof AssistantJobStore, Error>> = {};

  private now(): number {
    return Date.now() + this.clockOffsetMs;
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private take(operation: keyof AssistantJobStore): void {
    const error = this.failNext[operation];
    if (error) {
      delete this.failNext[operation];
      throw error;
    }
  }

  private sameConversation(a: AssistantJob, b: { destination: string; source_id: string; line_user_id: string }) {
    return a.destination === b.destination && a.source_id === b.source_id && a.line_user_id === b.line_user_id;
  }

  async enqueue(
    request: AssistantJobRequest,
    limits: { maxOutstandingPerConversation?: number; maxBacklog?: number } = {},
  ): Promise<EnqueueOutcome> {
    this.take("enqueue");
    const existing = [...this.jobs.values()].find((job) => job.line_event_id === request.lineEventId);
    if (existing) return { outcome: "duplicate", jobId: existing.id };
    const open = [...this.jobs.values()].filter((job) => job.status === "queued" || job.status === "running");
    const key = { destination: request.destination, source_id: request.sourceId, line_user_id: request.lineUserId };
    if (open.filter((job) => this.sameConversation(job, key)).length >= Math.max(1, limits.maxOutstandingPerConversation ?? 3)) {
      return { outcome: "rate_limited", jobId: null };
    }
    if (open.length >= Math.max(1, limits.maxBacklog ?? 500)) return { outcome: "queue_full", jobId: null };
    const now = this.iso(this.now());
    const job: AssistantJob = {
      id: randomUUID(),
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
      status: "queued",
      attempts: 0,
      max_attempts: Math.min(10, Math.max(1, request.maxAttempts ?? 3)),
      available_at: now,
      lease_token: null,
      lease_expires_at: null,
      worker_id: null,
      answer_text: null,
      answer_kind: null,
      delivery_state: "pending",
      delivery_channel: null,
      delivery_retry_key: randomUUID(),
      last_error_code: null,
      usage: null,
      tool_names: [],
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null,
    };
    this.jobs.set(job.id, job);
    return { outcome: "queued", jobId: job.id };
  }

  async claim(workerId: string, options: ClaimOptions): Promise<AssistantJob[]> {
    this.take("claim");
    const now = this.now();
    for (const job of this.jobs.values()) {
      if (job.status === "running" && Date.parse(job.lease_expires_at!) <= now && job.attempts >= job.max_attempts + 2) {
        Object.assign(job, {
          status: "failed", lease_token: null, lease_expires_at: null, reply_token: null,
          last_error_code: "attempts_exhausted", completed_at: this.iso(now), updated_at: this.iso(now),
        });
      }
    }
    const running = [...this.jobs.values()]
      .filter((job) => job.status === "running" && Date.parse(job.lease_expires_at!) > now).length;
    const slots = Math.min(Math.max(options.limit, 0), Math.max(options.maxRunning - running, 0), 20);
    if (slots <= 0) return [];
    const open = [...this.jobs.values()].filter((job) => job.status === "queued" || job.status === "running");
    const order = (a: AssistantJob, b: AssistantJob) =>
      a.event_timestamp_ms - b.event_timestamp_ms || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
    const candidates = open
      .filter((job) => (job.status === "queued" && Date.parse(job.available_at) <= now)
        || (job.status === "running" && Date.parse(job.lease_expires_at!) <= now))
      .filter((job) => !open.some((other) => other.id !== job.id && this.sameConversation(other, job) && order(other, job) < 0))
      .sort((a, b) => a.available_at.localeCompare(b.available_at) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .slice(0, slots);
    const leaseMs = Math.min(Math.max(options.leaseSeconds, 30), 900) * 1000;
    for (const job of candidates) {
      Object.assign(job, {
        status: "running",
        attempts: job.attempts + 1,
        lease_token: randomUUID(),
        lease_expires_at: this.iso(now + leaseMs),
        worker_id: workerId,
        started_at: job.started_at ?? this.iso(now),
        updated_at: this.iso(now),
      });
    }
    return candidates.map((job) => ({ ...job }));
  }

  private owned(jobId: string, leaseToken: string): AssistantJob | null {
    const job = this.jobs.get(jobId);
    return job && job.status === "running" && job.lease_token === leaseToken ? job : null;
  }

  async recordAnswer(jobId: string, leaseToken: string, input: RecordAnswerInput): Promise<boolean> {
    this.take("recordAnswer");
    const job = this.owned(jobId, leaseToken);
    if (!job || job.answer_text !== null) return false;
    const now = this.now();
    Object.assign(job, {
      answer_text: input.answer,
      answer_kind: input.kind,
      usage: input.usage ?? null,
      tool_names: [...(input.toolNames ?? [])],
      lease_expires_at: this.iso(Math.max(Date.parse(job.lease_expires_at!), now + 60_000)),
      updated_at: this.iso(now),
    });
    if (input.kind === "answer" && input.turn && !this.turns.some((turn) => turn.jobId === job.id)) {
      this.turns.push({
        id: ++this.turnId,
        jobId: job.id,
        destination: job.destination,
        sourceId: job.source_id,
        lineUserId: job.line_user_id,
        question: job.question,
        answer: input.answer,
        businessDate: input.turn.businessDate,
        context: input.turn.context,
        eventTimestampMs: job.event_timestamp_ms,
        expiresAt: now + Math.min(Math.max(input.turnTtlSeconds ?? 1800, 60), 86400) * 1000,
      });
      const mine = this.turns
        .filter((turn) => turn.destination === job.destination && turn.sourceId === job.source_id && turn.lineUserId === job.line_user_id)
        .sort((a, b) => b.eventTimestampMs - a.eventTimestampMs || b.id - a.id);
      const keep = new Set(mine.slice(0, Math.min(Math.max(input.maxTurns ?? 6, 1), 20)).map((turn) => turn.id));
      for (let index = this.turns.length - 1; index >= 0; index -= 1) {
        const turn = this.turns[index]!;
        if (mine.includes(turn) && (!keep.has(turn.id) || turn.expiresAt <= now)) this.turns.splice(index, 1);
      }
    }
    return true;
  }

  async setDelivery(
    jobId: string,
    leaseToken: string,
    from: readonly AssistantDeliveryState[],
    to: AssistantDeliveryState,
    channel?: "reply" | "push",
  ): Promise<boolean> {
    this.take("setDelivery");
    const job = this.owned(jobId, leaseToken);
    if (!job || !from.includes(job.delivery_state)) return false;
    Object.assign(job, {
      delivery_state: to,
      delivery_channel: channel ?? job.delivery_channel,
      reply_token: to === "reply_started" || to === "push_started" ? null : job.reply_token,
      updated_at: this.iso(this.now()),
    });
    return true;
  }

  async complete(jobId: string, leaseToken: string, status: "completed" | "failed", errorCode: string | null = null): Promise<boolean> {
    this.take("complete");
    const job = this.owned(jobId, leaseToken);
    if (!job) return false;
    const now = this.iso(this.now());
    Object.assign(job, {
      status, lease_token: null, lease_expires_at: null, reply_token: null,
      last_error_code: errorCode ?? job.last_error_code, completed_at: now, updated_at: now,
    });
    return true;
  }

  async retry(jobId: string, leaseToken: string, delaySeconds: number, errorCode: string): Promise<boolean> {
    this.take("retry");
    const job = this.owned(jobId, leaseToken);
    if (!job) return false;
    const now = this.now();
    Object.assign(job, {
      status: "queued", lease_token: null, lease_expires_at: null,
      available_at: this.iso(now + Math.min(Math.max(delaySeconds, 0), 3600) * 1000),
      last_error_code: errorCode, updated_at: this.iso(now),
    });
    return true;
  }

  async loadTurns(key: ConversationKey, beforeEventMs: number, limit: number): Promise<ConversationTurn[]> {
    this.take("loadTurns");
    const now = this.now();
    return this.turns
      .filter((turn) => turn.destination === key.destination && turn.sourceId === key.sourceId
        && turn.lineUserId === key.lineUserId && turn.expiresAt > now && turn.eventTimestampMs < beforeEventMs)
      .sort((a, b) => b.eventTimestampMs - a.eventTimestampMs || b.id - a.id)
      .slice(0, Math.min(Math.max(limit, 0), 8))
      .map(({ question, answer, businessDate, context, eventTimestampMs }) => ({
        question, answer, businessDate, context, eventTimestampMs,
      }))
      .reverse();
  }

  /** Test helper: make a running job's lease look expired (simulated crash). */
  expireLease(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job?.status === "running") job.lease_expires_at = this.iso(this.now() - 1);
  }

  /** Test helper: make queued jobs available now (skip the backoff). */
  makeAvailable(): void {
    for (const job of this.jobs.values()) {
      if (job.status === "queued") job.available_at = this.iso(this.now() - 1);
    }
  }
}
