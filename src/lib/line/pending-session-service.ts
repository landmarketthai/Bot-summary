import type { SupabaseClient } from "@supabase/supabase-js";
import { getRuntimeEnvironment } from "@/lib/runtime-environment";

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class PendingSessionGenerationConflictError extends Error {
  constructor(sessionKey: string, expectedGeneration: string) {
    super(
      `pending session generation conflict for ${sessionKey}: expected generation ${expectedGeneration} is no longer current`,
    );
    this.name = "PendingSessionGenerationConflictError";
  }
}

// Thrown when a content item arrives after the immutable first-close
// boundary for its generation — Release B rejects it outright rather than
// appending it to the ledger (see 0032_pending_session_finalization_barrier.sql).
export class PendingSessionAfterCloseBoundaryError extends Error {
  constructor(sessionKey: string, closeEventTimestampMs: number) {
    super(
      `pending session append rejected for ${sessionKey}: message arrived after the immutable close boundary at ${closeEventTimestampMs}`,
    );
    this.name = "PendingSessionAfterCloseBoundaryError";
  }
}

export class PendingSessionClosedError extends Error {
  constructor(
    sessionKey: string,
    public readonly reason: "terminalized" | "deadline_elapsed" | "close_generation_conflict",
  ) {
    super(`pending session append rejected for ${sessionKey}: ${reason}`);
    this.name = "PendingSessionClosedError";
  }
}

/**
 * The first close was refused because the session's authoritative document
 * moved between the entry gate validating a snapshot of it and the close
 * boundary being stamped. Recoverable by construction: no boundary was
 * written, so the operator can simply close again against the grown document.
 */
export class PendingSessionStaleValidationSnapshotError extends Error {
  constructor(
    sessionKey: string,
    public readonly expectedRevision: number | null,
    public readonly currentRevision: number | null,
  ) {
    super(
      `pending session close refused for ${sessionKey}: validation snapshot was stale `
      + `(expected ingest_revision ${expectedRevision}, found ${currentRevision})`,
    );
    this.name = "PendingSessionStaleValidationSnapshotError";
  }
}

export interface PendingSession {
  id:                        string;
  session_key:               string;
  source_id:                 string;
  accumulated_text:          string;
  latest_reply_token:        string | null;
  line_user_id:              string | null;
  created_at:                string;
  updated_at:                string;
  session_generation:        string;
  close_event_timestamp_ms:  number | null;
  close_requested_at:        string | null;
  close_line_event_id:       string | null;
  close_finalize_started_at: string | null;
  terminalized:              boolean;
  next_attempt_at:           string | null;
  close_deadline_at:         string | null;
  close_session_generation:  string | null;
  expected_item_count:       number | null;
  ingest_revision:           number;
  finalization_started_at?:       string | null;
  finalized_at?:                  string | null;
  finalization_status?:
    | "pending" | "processing" | "failed_closed" | "duplicate" | "finalized"
    /** 20260829090000: inactivity-expired draft that accepted zero items. */
    | "expired_empty_draft";
  finalization_error?:            unknown | null;
  finalized_produce_session_id?:  string | null;
  /** P2E: generated economic-cycle identity; NULL is legacy/unbound. */
  accountability_round_id?:       string | null;
  /** 0050: structured review hold — non-NULL blocks Produce persistence. */
  finalize_hold_until?:           string | null;
  finalize_confirmed_at?:         string | null;
  finalize_confirm_line_event_id?: string | null;
  /** 0061: environment ownership — see src/lib/runtime-environment.ts. */
  runtime_environment?:           "production" | "preview" | "development" | null;
  /** Hotfix: authoritative opener boundary for a plain-text generation. */
  plain_text_opened_line_event_id?: string | null;
  plain_text_opened_line_timestamp_ms?: number | null;
  /**
   * P1-B: a VALID close arrived and the entry gate refused it without
   * scheduling finalization. Bounds the correction window; the stamp is
   * generation-scoped so a rotation retires it with no cleanup write.
   */
  close_refused_at?:                  string | null;
  close_refused_session_generation?:  string | null;
  /** 0049: structured menu sessions are non-null; legacy/plain-text is NULL. */
  entry_origin?:                      string | null;
  /**
   * Task 2 (20260825091000): the finalized produce_sessions.id this draft is
   * meant to supersede once IT finalizes successfully. NULL for every
   * ordinary session. See src/lib/produce/replacement-draft.ts.
   */
  replaces_produce_session_id?:       string | null;
}

export interface OpenPlainTextGenerationInput {
  sessionKey: string;
  sourceId: string;
  lineUserId: string;
  lineEventId: string;
  lineTimestampMs: number;
  text: string;
  replyToken: string | null;
  markClose: boolean;
  expectedItemCount?: number;
  expectedSessionGeneration?: string;
}

export interface OpenPlainTextGenerationResult {
  opened: boolean;
  reason: string;
  reconciled_count?: number;
  session?: PendingSession;
}

export type DeferredProduceAction =
  | "admitted"
  | "reconciled"
  | "deferred"
  | "rejected_orphan"
  | "rejected_before_opener"
  | "rejected_after_close";

export interface AppendOrDeferProduceItemResult {
  action: DeferredProduceAction;
  reason?: string;
  idempotent?: boolean;
  session_generation?: string | null;
  session?: PendingSession;
}

export interface ExpiredDeferredProduceEvent {
  line_event_id: string;
  raw_message_id: string;
  session_key: string;
  source_id: string;
  line_user_id: string;
  line_timestamp_ms: number;
  raw_text: string;
  reply_token: string | null;
  status: Exclude<DeferredProduceAction, "admitted" | "reconciled" | "deferred">;
  defer_reason: string;
  session_generation: string | null;
  opener_line_event_id: string | null;
  opener_line_timestamp_ms: number | null;
  close_line_event_id: string | null;
  close_line_timestamp_ms: number | null;
  received_at: string;
  resolved_at: string;
}

export interface RecoverableDeferredEventRow {
  line_event_id: string;
  raw_message_id: string;
  session_key: string;
  source_id: string;
  line_user_id: string;
  line_timestamp_ms: number;
  raw_text: string;
  status: "waiting" | "rejected_before_opener" | "rejected_after_close" | "rejected_orphan";
  defer_reason: string;
  session_generation: string | null;
  opener_line_event_id: string | null;
  close_line_event_id: string | null;
  close_line_timestamp_ms: number | null;
  expires_at: string | null;
  /** Durable no-header-burst identity — see 20260825090000. NULL pre-migration. */
  recovery_bundle_id: string | null;
}

export interface ConfirmFinalizationResult {
  accepted: boolean;
  reason?: string;
  readiness_reason?: string;
  admission_count?: number;
  ingest_count?: number;
  straggler_count?: number;
  session?: PendingSession;
}

export interface TryFinalizeResult {
  status:
    | "skipped"
    | "stale_snapshot"
    | "pending"
    // The authoritative document grew after the close boundary and the new
    // content needs a review the operator has never seen. Finalization is
    // parked, not failed: a distinct later confirmation resumes it.
    | "validation_held"
    | "failed_closed"
    | "duplicate"
    | "finalized";
  reason?:             string;
  missing?:            number[];
  current_revision?:   number;
  session_id?:         string;
  validation_errors?:  string[];
  notification_id?:    string;
  next_attempt_at?:    string;
}

export interface ClaimFinalizeResult {
  claimed:         boolean;
  reason?:         string;
  admission_count?: number;
  ingest_count?:   number;
  straggler_count?: number;
  session?:        PendingSession;
}

export interface PendingSessionLookup {
  session: PendingSession | null;
  reason: "found" | "no_row" | "terminalized" | "db_error";
  error?: string;
}

/**
 * Active Produce pending means terminalized = false.
 * A terminalized row is immutable historical evidence for the same unique
 * session_key — lookup() still returns it for journey/audit readers.
 */
export function isActivePendingSession(
  row: PendingSession | null | undefined,
): row is PendingSession {
  return row != null && row.terminalized !== true;
}

export interface ReplacePendingSessionInput {
  sessionKey:                string;
  sourceId:                  string;
  expectedSessionGeneration: string;
  text:                      string;
  replyToken:                string | null;
  lineUserId:                string | null;
  lineEventId:               string;
  lineTimestampMs:           number;
  markClose:                 boolean;
  expectedItemCount?:        number;
}

interface PendingRawMessage {
  line_event_id: string;
  raw_text: string | null;
  payload: unknown;
  created_at: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

function isMissingReorderRpc(error: unknown): boolean {
  const value = error as { message?: unknown } | null;
  const message = error instanceof Error
    ? error.message
    : typeof value?.message === "string" ? value.message : String(error);
  return /open_pending_plain_text_generation|append_or_defer_pending_produce_item|claim_expired_pending_produce_events/i.test(message)
    && /unexpected rpc/i.test(message);
}

export class PendingSessionService {
  constructor(private readonly supabase: AnyClient) {}

  async get(sessionKey: string): Promise<PendingSession | null> {
    return (await this.lookup(sessionKey)).session;
  }

  async lookup(sessionKey: string): Promise<PendingSessionLookup> {
    const { data, error } = await this.supabase
      .from("pending_sessions")
      .select("*")
      .eq("session_key", sessionKey)
      .maybeSingle();

    if (error) {
      return { session: null, reason: "db_error", error: error.message };
    }
    if (!data) return { session: null, reason: "no_row" };
    return { session: data as PendingSession, reason: "found" };
  }

  /**
   * Active-session resolution for append/close/open routing.
   * Never returns a terminalized row as the live pending session.
   */
  async lookupActive(sessionKey: string): Promise<PendingSessionLookup> {
    const result = await this.lookup(sessionKey);
    if (result.reason !== "found" || !result.session) return result;
    if (!isActivePendingSession(result.session)) {
      return { session: null, reason: "terminalized" };
    }
    return result;
  }

  async openPlainTextGeneration(
    input: OpenPlainTextGenerationInput,
  ): Promise<OpenPlainTextGenerationResult> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (this.supabase as any).rpc(
        "open_pending_plain_text_generation",
        {
          p_session_key: input.sessionKey,
          p_source_id: input.sourceId,
          p_line_user_id: input.lineUserId,
          p_line_event_id: input.lineEventId,
          p_line_timestamp_ms: input.lineTimestampMs,
          p_raw_text: input.text,
          p_reply_token: input.replyToken,
          p_mark_close: input.markClose,
          p_expected_item_count: input.expectedItemCount ?? null,
          p_expected_session_generation: input.expectedSessionGeneration ?? null,
          p_runtime_environment: getRuntimeEnvironment(),
        },
      );
      if (error) {
        if (isMissingReorderRpc(error)) return this.openPlainTextGenerationLegacy(input);
        throw new Error(`plain-text pending generation open failed: ${error.message}`);
      }
      // A few repository fakes model an unknown RPC as a null success. The
      // deployed database never does; retain the rolling legacy contract there.
      if (!data) return this.openPlainTextGenerationLegacy(input);
      return data as OpenPlainTextGenerationResult;
    } catch (error) {
      if (isMissingReorderRpc(error)) return this.openPlainTextGenerationLegacy(input);
      throw error;
    }
  }

  private async openPlainTextGenerationLegacy(
    input: OpenPlainTextGenerationInput,
  ): Promise<OpenPlainTextGenerationResult> {
    let existing = await this.get(input.sessionKey);
    if (!existing) {
      await this.create(
        input.sessionKey,
        input.sourceId,
        input.text,
        input.replyToken,
        input.lineUserId,
      );
      existing = await this.get(input.sessionKey);
    }
    if (!existing) throw new Error("pending session missing after legacy create");
    const expected = input.expectedSessionGeneration ?? existing.session_generation;
    const session = await this.replaceGeneration({
      sessionKey: input.sessionKey,
      sourceId: input.sourceId,
      expectedSessionGeneration: expected,
      text: input.text,
      replyToken: input.replyToken,
      lineUserId: input.lineUserId,
      lineEventId: input.lineEventId,
      lineTimestampMs: input.lineTimestampMs,
      markClose: input.markClose,
      expectedItemCount: input.expectedItemCount,
    });
    return {
      opened: session !== null,
      reason: session ? "legacy_schema_fallback" : "generation_conflict",
      reconciled_count: 0,
      session: session ?? undefined,
    };
  }

  async appendOrDeferProduceItem(input: {
    rawMessageId: string;
    sessionKey: string;
    sourceId: string;
    lineUserId: string;
    lineEventId: string;
    lineTimestampMs: number;
    text: string;
    replyToken: string | null;
  }): Promise<AppendOrDeferProduceItemResult> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (this.supabase as any).rpc(
        "append_or_defer_pending_produce_item",
        {
          p_raw_message_id: input.rawMessageId,
          p_session_key: input.sessionKey,
          p_source_id: input.sourceId,
          p_line_user_id: input.lineUserId,
          p_line_event_id: input.lineEventId,
          p_line_timestamp_ms: input.lineTimestampMs,
          p_raw_text: input.text,
          p_reply_token: input.replyToken,
          p_runtime_environment: getRuntimeEnvironment(),
        },
      );
      if (error) {
        if (isMissingReorderRpc(error)) return { action: "rejected_orphan" };
        throw new Error(`Produce item reorder admission failed: ${error.message}`);
      }
      if (!data) return { action: "rejected_orphan" };
      return data as AppendOrDeferProduceItemResult;
    } catch (error) {
      if (isMissingReorderRpc(error)) return { action: "rejected_orphan" };
      throw error;
    }
  }

  async listRecoverableDeferredEvents(
    sessionKey: string,
  ): Promise<RecoverableDeferredEventRow[]> {
    const { data, error } = await this.supabase
      .from("pending_produce_deferred_events")
      .select(
        "line_event_id, raw_message_id, session_key, source_id, line_user_id, line_timestamp_ms, raw_text, status, defer_reason, session_generation, opener_line_event_id, close_line_event_id, close_line_timestamp_ms, expires_at, recovery_bundle_id",
      )
      .eq("session_key", sessionKey)
      .eq("runtime_environment", getRuntimeEnvironment())
      .in("status", [
        "waiting",
        "rejected_before_opener",
        "rejected_after_close",
        "rejected_orphan",
      ]);
    if (error) {
      throw new Error(`recoverable Produce deferred lookup failed: ${error.message}`);
    }
    return (data ?? []) as RecoverableDeferredEventRow[];
  }

  /**
   * Explicit-recovery append for ONE deferred event. Wraps
   * append_pending_session and the pending_produce_deferred_events status
   * flip in a single RPC transaction (20260825090000), so a crash between
   * "appended" and "marked admitted" is impossible — either both commit or
   * neither does. This is what lets recoverLatestRejectedBundle mark each
   * event's durable status right after its own append, instead of batching a
   * mark at the end of the whole loop (the old shape that could leave
   * already-appended rows permanently stuck at 'waiting'/'rejected_*').
   */
  async recoverDeferredEvent(
    sessionKey: string,
    lineEventId: string,
    rawText: string,
    replyToken: string | null,
    lineTimestampMs: number,
    expectedGeneration: string,
  ): Promise<PendingSession> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).rpc(
      "recover_pending_produce_deferred_event",
      {
        p_session_key:                 sessionKey,
        p_line_event_id:               lineEventId,
        p_raw_text:                    rawText,
        p_reply_token:                 replyToken,
        p_line_timestamp_ms:           lineTimestampMs,
        p_expected_session_generation: expectedGeneration,
      },
    );
    if (error) throw new Error(`Produce deferred recovery append failed: ${error.message}`);
    return this.mapAppendRpcResult(sessionKey, data, expectedGeneration, lineTimestampMs);
  }

  async recordBoundaryRejectedProduceItem(input: {
    rawMessageId: string;
    sessionKey: string;
    sourceId: string;
    lineUserId: string;
    lineEventId: string;
    lineTimestampMs: number;
    text: string;
    replyToken: string | null;
    status: "rejected_before_opener" | "rejected_after_close" | "rejected_orphan";
    sessionGeneration: string | null;
    closeLineEventId: string | null;
    closeLineTimestampMs: number | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase
      .from("pending_produce_deferred_events")
      .upsert(
        {
          line_event_id: input.lineEventId,
          raw_message_id: input.rawMessageId,
          session_key: input.sessionKey,
          source_id: input.sourceId,
          line_user_id: input.lineUserId,
          line_timestamp_ms: input.lineTimestampMs,
          raw_text: input.text,
          reply_token: input.replyToken,
          runtime_environment: getRuntimeEnvironment(),
          status: input.status,
          defer_reason: input.status,
          session_generation: input.sessionGeneration,
          close_line_event_id: input.closeLineEventId,
          close_line_timestamp_ms: input.closeLineTimestampMs,
          received_at: now,
          resolved_at: now,
        },
        { onConflict: "line_event_id", ignoreDuplicates: true },
      );
    if (error) {
      throw new Error(`rejected Produce evidence persist failed: ${error.message}`);
    }
  }

  async claimExpiredDeferredProduceEvents(
    limit = 25,
  ): Promise<ExpiredDeferredProduceEvent[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (this.supabase as any).rpc(
        "claim_expired_pending_produce_events",
        { p_limit: limit, p_runtime_environment: getRuntimeEnvironment() },
      );
      if (error) {
        if (isMissingReorderRpc(error)) return [];
        throw new Error(`expired Produce reorder claim failed: ${error.message}`);
      }
      return (data ?? []) as ExpiredDeferredProduceEvent[];
    } catch (error) {
      if (isMissingReorderRpc(error)) return [];
      throw error;
    }
  }

  async create(
    sessionKey:  string,
    sourceId:    string,
    text:        string,
    replyToken:  string | null,
    lineUserId:  string | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase.from("pending_sessions").upsert(
      {
        session_key:        sessionKey,
        source_id:          sourceId,
        accumulated_text:   text,
        latest_reply_token: replyToken,
        line_user_id:       lineUserId,
        updated_at:         now,
        // Reset created_at so queryStart in rebuildForFinalization is correct
        // even when a stale row from a prior session survives the upsert.
        created_at:         now,
        close_event_timestamp_ms:  null,
        close_requested_at:        null,
        close_line_event_id:       null,
        close_finalize_started_at: null,
        terminalized:              false,
        next_attempt_at:           null,
        close_deadline_at:         null,
        close_session_generation:  null,
        expected_item_count:       null,
        ingest_revision:           0,
        finalization_started_at:      null,
        finalized_at:                 null,
        finalization_status:          "pending",
        finalization_error:           null,
        finalized_produce_session_id: null,
        runtime_environment:          getRuntimeEnvironment(),
      },
      { onConflict: "session_key" },
    );
    if (error) throw new Error(`pending session create failed: ${error.message}`);
  }

  async replaceGeneration(
    input: ReplacePendingSessionInput,
  ): Promise<PendingSession | null> {
    const now = new Date();
    const nowIso = now.toISOString();
    const replacementGeneration = crypto.randomUUID();
    const closeDeadline = input.markClose
      ? new Date(now.getTime() + 30_000).toISOString()
      : null;
    const nextAttempt = input.markClose
      ? new Date(now.getTime() + 8_000).toISOString()
      : null;
    const { data, error } = await this.supabase
      .from("pending_sessions")
      .update({
        session_generation:        replacementGeneration,
        source_id:                 input.sourceId,
        accumulated_text:          input.text,
        latest_reply_token:        input.replyToken,
        line_user_id:              input.lineUserId,
        created_at:                nowIso,
        updated_at:                nowIso,
        close_event_timestamp_ms:  input.markClose ? input.lineTimestampMs : null,
        close_requested_at:        input.markClose ? nowIso : null,
        close_line_event_id:       input.markClose ? input.lineEventId : null,
        close_finalize_started_at: null,
        terminalized:              false,
        next_attempt_at:           nextAttempt,
        close_deadline_at:         closeDeadline,
        close_session_generation:  input.markClose ? replacementGeneration : null,
        expected_item_count:       input.markClose ? input.expectedItemCount ?? null : null,
        ingest_revision:           1,
        finalization_started_at:      null,
        finalized_at:                 null,
        finalization_status:          "pending",
        finalization_error:           null,
        finalized_produce_session_id: null,
        runtime_environment:          getRuntimeEnvironment(),
      })
      .eq("session_key", input.sessionKey)
      .eq("session_generation", input.expectedSessionGeneration)
      .select("*")
      .maybeSingle();

    if (error) {
      throw new Error(`pending session generation replace failed: ${error.message}`);
    }
    if (!data) return null;

    try {
      const { error: ingestError } = await this.supabase
        .from("pending_session_ingest")
        .insert({
          session_key:        input.sessionKey,
          session_generation: replacementGeneration,
          line_event_id:      input.lineEventId,
          line_timestamp_ms:  input.lineTimestampMs,
          raw_text:           input.text,
        });
      if (ingestError) {
        throw new Error(`pending session replacement ingest failed: ${ingestError.message}`);
      }

      const { error: admissionError } = await this.supabase
        .from("pending_session_admission")
        .insert({
          session_key:        input.sessionKey,
          session_generation: replacementGeneration,
          line_event_id:      input.lineEventId,
          line_timestamp_ms:  input.lineTimestampMs,
        });
      if (admissionError) {
        throw new Error(`pending session replacement admission failed: ${admissionError.message}`);
      }
    } catch (registrationError) {
      await this.deleteGeneration(input.sessionKey, replacementGeneration);
      throw registrationError;
    }

    return data as PendingSession;
  }

  async append(
    sessionKey:          string,
    newText:             string,
    replyToken:          string | null,
    lineEventId?:        string,
    lineTimestampMs?:    number,
    markClose?:          boolean,
    expectedGeneration?: string,
    expectedItemCount?:  number,
    expectedIngestRevision?: number,
  ): Promise<PendingSession> {
    const args: Record<string, unknown> = {
      p_session_key:                  sessionKey,
      p_new_text:                     newText,
      p_reply_token:                  replyToken,
      p_line_event_id:                lineEventId     ?? null,
      p_line_timestamp_ms:            lineTimestampMs ?? null,
      p_mark_close:                   markClose       ?? false,
      p_expected_session_generation:  expectedGeneration ?? null,
      p_expected_item_count:          expectedItemCount  ?? null,
    };
    // The 9th argument is sent ONLY when a revision is actually being pinned,
    // so ordinary appends keep resolving to the 8-arg overload. That keeps the
    // hot path independent of 20260831120000 being deployed, instead of making
    // every append depend on the new overload existing.
    if (expectedIngestRevision != null) {
      args.p_expected_ingest_revision = expectedIngestRevision;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).rpc("append_pending_session", args);
    if (error) throw new Error(`pending session append failed: ${error.message}`);
    return this.mapAppendRpcResult(sessionKey, data, expectedGeneration, lineTimestampMs);
  }

  /**
   * Record transport/operator activity for control-plane input that must not
   * enter the authoritative Produce document.
   *
   * The key + generation + live-row predicates are evaluated by PostgreSQL in
   * the same UPDATE as the metadata write. A stale event therefore returns
   * null and cannot touch a replacement generation. Deliberately does not
   * change accumulated_text, ingest_revision, close-boundary fields, or the
   * ingest/admission ledgers.
   */
  async touchControlActivity(
    sessionKey: string,
    expectedGeneration: string,
    replyToken: string | null,
  ): Promise<PendingSession | null> {
    const { data, error } = await this.supabase
      .from("pending_sessions")
      .update({
        latest_reply_token: replyToken,
        updated_at: new Date().toISOString(),
      })
      .eq("session_key", sessionKey)
      .eq("session_generation", expectedGeneration)
      .eq("terminalized", false)
      .select("*")
      .maybeSingle();

    if (error) {
      throw new Error(`pending session control activity update failed: ${error.message}`);
    }
    return data as PendingSession | null;
  }

  /**
   * Park finalization for a closed generation whose document grew past the
   * close boundary into review-required territory. Returns false when the row
   * moved underneath us (generation conflict, terminalized, revision moved
   * again) — the caller must then not treat the session as held.
   */
  async holdValidationReview(
    sessionKey: string,
    expectedGeneration: string,
    expectedIngestRevision: number | null,
  ): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).rpc("hold_pending_validation_review", {
      p_session_key:                 sessionKey,
      p_expected_session_generation: expectedGeneration,
      p_expected_ingest_revision:    expectedIngestRevision,
    });
    if (error) throw new Error(`pending validation hold failed: ${error.message}`);
    return (data as { accepted?: boolean } | null)?.accepted === true;
  }

  /** Re-schedule finalization for a held generation once its review is confirmed. */
  async resumeCloseFinalization(
    sessionKey: string,
    expectedGeneration: string,
  ): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).rpc("resume_pending_close_finalization", {
      p_session_key:                 sessionKey,
      p_expected_session_generation: expectedGeneration,
    });
    if (error) throw new Error(`pending close resume failed: ${error.message}`);
    return (data as { accepted?: boolean } | null)?.accepted === true;
  }

  /** Shared by append() and recoverDeferredEvent() — both call an RPC that
   * wraps append_pending_session and returns its {accepted, reason, session}
   * shape directly. */
  private mapAppendRpcResult(
    sessionKey: string,
    data: unknown,
    expectedGeneration?: string,
    lineTimestampMs?: number,
  ): PendingSession {
    const result = data as {
      accepted: boolean;
      reason?: string;
      session?: PendingSession;
    } | null;
    if (result?.reason === "duplicate_event" && result.session) {
      return result.session;
    }
    if (!result || !result.accepted) {
      const reason = result?.reason;
      if (reason === "generation_conflict" && expectedGeneration) {
        throw new PendingSessionGenerationConflictError(sessionKey, expectedGeneration);
      }
      if (reason === "stale_validation_snapshot") {
        const payload = data as {
          expected_revision?: number | null;
          current_revision?: number | null;
        };
        throw new PendingSessionStaleValidationSnapshotError(
          sessionKey,
          payload?.expected_revision ?? null,
          payload?.current_revision ?? null,
        );
      }
      if (reason === "after_close_boundary") {
        const boundary = result?.session?.close_event_timestamp_ms ?? lineTimestampMs ?? 0;
        throw new PendingSessionAfterCloseBoundaryError(sessionKey, boundary);
      }
      if (
        reason === "terminalized"
        || reason === "deadline_elapsed"
        || reason === "close_generation_conflict"
      ) {
        throw new PendingSessionClosedError(sessionKey, reason);
      }
      throw new Error(`pending session not found for append: ${sessionKey}`);
    }
    return result.session as PendingSession;
  }

  /**
   * Releases a structured finalization hold after operator confirmation.
   * Control event only: no admission, ingest, synthetic text, or Produce write.
   */
  async confirmFinalization(
    sessionKey: string,
    lineUserId: string,
    confirmLineEventId: string,
    expectedGeneration?: string | null,
  ): Promise<ConfirmFinalizationResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).rpc(
      "confirm_produce_structured_finalization",
      {
        p_session_key:                 sessionKey,
        p_line_user_id:                lineUserId,
        p_confirm_line_event_id:       confirmLineEventId,
        p_expected_session_generation: expectedGeneration ?? null,
      },
    );
    if (error) throw new Error(`structured finalization confirm failed: ${error.message}`);
    return data as ConfirmFinalizationResult;
  }

  async tryFinalizeGeneration(
    sessionKey:         string,
    expectedGeneration: string,
    expectedLineUserId: string | null,
    snapshotRevision:   number,
    sessionHash:        string,
    rawText:            string,
    sessionPayload:     Record<string, unknown>,
    items:              Array<Record<string, unknown>>,
    /**
     * Previous-generation identities of the SAME business document. The RPC
     * reserves these before it reserves `sessionHash`, which is what keeps two
     * application builds from each persisting one document during a rolling
     * deploy. See business-fingerprint.ts for V0/V1/V2.
     */
    compatibilityHashes: string[] = [],
  ): Promise<TryFinalizeResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).rpc("try_finalize_pending_generation", {
      p_session_key:         sessionKey,
      p_expected_generation: expectedGeneration,
      p_expected_line_user_id: expectedLineUserId,
      p_snapshot_revision:   snapshotRevision,
      p_session_hash:        sessionHash,
      p_raw_text:            rawText,
      p_session:             sessionPayload,
      p_items:               items,
      p_compatibility_hashes: compatibilityHashes,
    });
    if (error) throw new Error(`pending session finalize failed: ${error.message}`);
    return data as TryFinalizeResult;
  }

  async admit(
    sessionKey:          string,
    lineEventId:         string,
    lineTimestampMs:     number,
    expectedGeneration?: string,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).rpc("admit_pending_session_event", {
      p_session_key:                  sessionKey,
      p_line_event_id:                lineEventId,
      p_line_timestamp_ms:            lineTimestampMs,
      p_expected_session_generation:  expectedGeneration ?? null,
    });
    if (error) throw new Error(`pending session admit failed: ${error.message}`);
    if (data === false) {
      if (expectedGeneration) {
        throw new PendingSessionGenerationConflictError(sessionKey, expectedGeneration);
      }
      throw new Error(`pending session admit failed: session not found for ${sessionKey}`);
    }
  }

  async registerIngest(
    sessionKey:     string,
    lineEventId:    string,
    lineTimestampMs: number,
    rawText:        string,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (this.supabase as any).rpc("register_pending_session_ingest", {
      p_session_key:       sessionKey,
      p_line_event_id:     lineEventId,
      p_line_timestamp_ms: lineTimestampMs,
      p_raw_text:          rawText,
    });
    if (error) throw new Error(`pending session register ingest failed: ${error.message}`);
  }

  async claimFinalize(
    sessionKey:          string,
    expectedGeneration?: string,
  ): Promise<ClaimFinalizeResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (this.supabase as any).rpc("claim_pending_close_finalize", {
      p_session_key:                 sessionKey,
      p_expected_session_generation: expectedGeneration ?? null,
    });
    if (error) throw new Error(`pending session claim failed: ${error.message}`);
    return data as ClaimFinalizeResult;
  }

  async deferTransientFinalizationRetry(
    sessionKey: string,
    sessionGeneration: string,
    ingestRevision: number,
    errorMessage: string,
    retryAfterMs = 15_000,
  ): Promise<{ scheduled: boolean; nextAttemptAt: string }> {
    const now = new Date();
    const nextAttemptAt = new Date(now.getTime() + retryAfterMs).toISOString();
    const { data, error } = await (this.supabase as SupabaseClient)
      .from("pending_sessions")
      .update({
        next_attempt_at: nextAttemptAt,
        finalization_status: "pending",
        finalization_error: {
          reason: "transient_reconstruction_error",
          retryable: true,
          error: errorMessage,
          last_failed_at: now.toISOString(),
        },
      })
      .eq("session_key", sessionKey)
      .eq("session_generation", sessionGeneration)
      .eq("ingest_revision", ingestRevision)
      .eq("terminalized", false)
      .select("session_generation");
    if (error) throw new Error(`defer transient finalization retry failed: ${error.message}`);
    return { scheduled: (data ?? []).length > 0, nextAttemptAt };
  }
  async loadIngestRows(
    sessionKey:        string,
    sessionGeneration: string,
    closeTimestampMs:  number,
  ): Promise<Array<{ line_event_id: string; line_timestamp_ms: number; raw_text: string }>> {
    const { data, error } = await this.supabase
      .from("pending_session_ingest")
      .select("line_event_id, line_timestamp_ms, raw_text")
      .eq("session_key", sessionKey)
      .eq("session_generation", sessionGeneration)
      .lte("line_timestamp_ms", closeTimestampMs)
      .order("line_timestamp_ms", { ascending: true })
      .order("line_event_id", { ascending: true });

    if (error) throw new Error(`pending session ingest load failed: ${error.message}`);
    return (data ?? []) as Array<{ line_event_id: string; line_timestamp_ms: number; raw_text: string }>;
  }

  async loadGenerationIngestRows(
    sessionKey: string,
    sessionGeneration: string,
  ): Promise<Array<{ line_event_id: string; line_timestamp_ms: number; raw_text: string }>> {
    const { data, error } = await this.supabase
      .from("pending_session_ingest")
      .select("line_event_id, line_timestamp_ms, raw_text")
      .eq("session_key", sessionKey)
      .eq("session_generation", sessionGeneration)
      .order("line_timestamp_ms", { ascending: true })
      .order("line_event_id", { ascending: true });
    if (error) throw new Error(`pending session generation ingest load failed: ${error.message}`);
    return (data ?? []) as Array<{ line_event_id: string; line_timestamp_ms: number; raw_text: string }>;
  }

  // Generation-scoped admission ledger through the immutable close boundary,
  // the counterpart of loadIngestRows. Structured finalization compares the two
  // event-id sets exactly; equal counts are not evidence of the same set.
  async loadAdmissionRows(
    sessionKey:        string,
    sessionGeneration: string,
    closeTimestampMs:  number,
  ): Promise<Array<{ line_event_id: string; line_timestamp_ms: number }>> {
    const { data, error } = await this.supabase
      .from("pending_session_admission")
      .select("line_event_id, line_timestamp_ms")
      .eq("session_key", sessionKey)
      .eq("session_generation", sessionGeneration)
      .lte("line_timestamp_ms", closeTimestampMs)
      .order("line_timestamp_ms", { ascending: true })
      .order("line_event_id", { ascending: true });

    if (error) throw new Error(`pending session admission load failed: ${error.message}`);
    return (data ?? []) as Array<{ line_event_id: string; line_timestamp_ms: number }>;
  }

  // Conditional update: only clears the claim if close_finalize_started_at still matches
  // the value set by our specific claim call, preventing a concurrent retry-close from
  // being inadvertently released.
  async releaseFinalizeClaim(sessionKey: string, claimedAt: string): Promise<void> {
    const { error } = await this.supabase
      .from("pending_sessions")
      .update({ close_finalize_started_at: null })
      .eq("session_key", sessionKey)
      .eq("close_finalize_started_at", claimedAt);
    if (error) throw new Error(`release finalize claim failed: ${error.message}`);
  }

  async delete(sessionKey: string): Promise<void> {
    const { error } = await this.supabase
      .from("pending_sessions")
      .delete()
      .eq("session_key", sessionKey);
    if (error) throw new Error(`pending session delete failed: ${error.message}`);
  }

  async deleteGeneration(sessionKey: string, sessionGeneration: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("pending_sessions")
      .delete()
      .eq("session_key", sessionKey)
      .eq("session_generation", sessionGeneration)
      .select("session_generation");
    if (error) throw new Error(`pending session generation delete failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  isExpired(session: PendingSession): boolean {
    return Date.now() - new Date(session.updated_at).getTime() > TIMEOUT_MS;
  }

  expiresAt(session: PendingSession): string {
    return new Date(new Date(session.updated_at).getTime() + TIMEOUT_MS).toISOString();
  }

  async rebuildForFinalization(
    session: PendingSession,
    endEventTimestamp: number,
  ): Promise<string> {
    // Fail closed rather than reconstruct from every sender in the source: a
    // null sender here would mean scoping this query by source_id alone,
    // which is exactly the cross-sender contamination this method exists to
    // prevent (see getPendingSessionKey in verify.ts).
    if (!session.line_user_id) {
      throw new Error(
        `pending session raw-message rebuild refused: no line_user_id to scope reconstruction for ${session.session_key}`,
      );
    }

    const queryStart = new Date(
      new Date(session.created_at).getTime() - 5 * 60 * 1000,
    ).toISOString();
    // Cap the upper bound to 60 s after the close event so stale created_at on
    // a re-used session row never pulls in messages from a different session.
    const queryEnd = new Date(endEventTimestamp + 60_000).toISOString();

    const { data, error } = await this.supabase
      .from("raw_messages")
      .select("line_event_id, raw_text, payload, created_at")
      .eq("source_id", session.source_id)
      .eq("user_id", session.line_user_id)
      .eq("message_type", "text")
      .gte("created_at", queryStart)
      .lte("created_at", queryEnd)
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(`pending session raw-message rebuild failed: ${error.message}`);
    }

    return rebuildPendingSessionText(
      session.accumulated_text,
      (data ?? []) as PendingRawMessage[],
      endEventTimestamp,
    );
  }
}

export function rebuildPendingSessionText(
  currentText: string,
  rows: PendingRawMessage[],
  endEventTimestamp: number,
): string {
  const initialHeader = currentText.split("\n")[0]?.trim();
  if (!initialHeader) return currentText;

  const ordered = rows
    .map((row, index) => ({
      ...row,
      index,
      eventTimestamp: readEventTimestamp(row.payload),
    }))
    .filter(
      (row) =>
        row.raw_text !== null
        && row.eventTimestamp !== null
        && row.eventTimestamp <= endEventTimestamp,
    )
    .sort(
      (a, b) =>
        (a.eventTimestamp! - b.eventTimestamp!)
        || a.created_at.localeCompare(b.created_at)
        || a.index - b.index,
    );

  let headerIndex = -1;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (ordered[index].raw_text?.trim() === initialHeader) {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex < 0) {
    // Throw so the caller can fail closed; returning stale accumulated_text
    // risks contaminating the session with data from an earlier session on the same source.
    throw new Error(
      `session header "${initialHeader}" not found in raw_messages — cannot reconstruct session boundary safely`,
    );
  }

  const seen = new Set<string>();
  const texts: string[] = [];
  for (const row of ordered.slice(headerIndex)) {
    if (seen.has(row.line_event_id)) continue;
    seen.add(row.line_event_id);
    texts.push(row.raw_text!);
  }

  return texts.length > 0 ? texts.join("\n") : currentText;
}

function readEventTimestamp(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || !("timestamp" in payload)) return null;
  const timestamp = (payload as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}
