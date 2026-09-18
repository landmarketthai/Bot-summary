/**
 * P2A Slice B — Physical Stock session + persistence service.
 *
 * Does NOT route LINE webhooks (Slice C).
 * Does NOT write produce_sessions / produce_items / inventory ledger.
 * Open/admit/candidate/finalize go through service_role SECURITY DEFINER RPCs.
 *
 * Barrier timing is DB-authoritative (clock_timestamp): quiet 8s / deadline 30s.
 * Test clocks exist only in in-memory test stubs — never as Production RPC args.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import {
  PHYSICAL_INVENTORY_PARSER_VERSION,
  type PhysicalInventoryParsedItem,
  type PhysicalInventoryParsedSession,
} from "./types";

type Supabase = SupabaseClient<Database>;

/** Documented Production quiet window (matches migration / Produce 0032). */
export const PHYSICAL_INVENTORY_CLOSE_QUIET_MS = 8_000;
/** Documented Production hard deadline after first close. */
export const PHYSICAL_INVENTORY_CLOSE_DEADLINE_MS = 30_000;

export type PhysicalInventorySessionStatus =
  | "open"
  | "closing"
  | "finalized"
  | "failed_closed"
  | "voided";

export type PhysicalInventorySessionRow =
  Database["public"]["Tables"]["physical_inventory_sessions"]["Row"];
export type PhysicalInventorySnapshotRow =
  Database["public"]["Tables"]["physical_inventory_snapshots"]["Row"];
export type PhysicalInventoryItemRow =
  Database["public"]["Tables"]["physical_inventory_items"]["Row"];

export type PhysicalInventoryFinalizeCandidate = {
  sessionId: string;
  sessionGeneration: string;
  status: PhysicalInventorySessionStatus;
  ingestRevision: number;
  ingestSetHash: string;
  closeEventTimestampMs: number | null;
  closeQuietUntil: string | null;
  closeDeadlineAt: string | null;
  ingests: Array<{
    line_event_id: string;
    line_timestamp_ms: number;
    kind: string;
    raw_text: string;
    ingest_revision: number;
    line_message_id?: string | null;
    raw_message_id?: string | null;
  }>;
};

export class PhysicalInventoryGenerationConflictError extends Error {
  constructor(message = "generation_conflict") {
    super(message);
    this.name = "PhysicalInventoryGenerationConflictError";
  }
}

export class PhysicalInventoryStaleRevisionError extends Error {
  constructor(message = "stale_ingest_revision") {
    super(message);
    this.name = "PhysicalInventoryStaleRevisionError";
  }
}

export class PhysicalInventoryStaleIngestHashError extends Error {
  constructor(message = "stale_ingest_hash") {
    super(message);
    this.name = "PhysicalInventoryStaleIngestHashError";
  }
}

export class PhysicalInventoryAfterCloseError extends Error {
  constructor(message = "session_closed") {
    super(message);
    this.name = "PhysicalInventoryAfterCloseError";
  }
}

export class PhysicalInventoryAfterCloseBoundaryError extends Error {
  constructor(message = "after_close_boundary") {
    super(message);
    this.name = "PhysicalInventoryAfterCloseBoundaryError";
  }
}

export class PhysicalInventoryCloseQuietWindowError extends Error {
  constructor(message = "close_quiet_window") {
    super(message);
    this.name = "PhysicalInventoryCloseQuietWindowError";
  }
}

export class PhysicalInventoryLineEventConflictError extends Error {
  constructor(message = "line_event_conflict") {
    super(message);
    this.name = "PhysicalInventoryLineEventConflictError";
  }
}

export class PhysicalInventoryCloseBoundaryRequiredError extends Error {
  constructor(message = "close_boundary_required") {
    super(message);
    this.name = "PhysicalInventoryCloseBoundaryRequiredError";
  }
}

function finalizationWarnings(session: PhysicalInventoryParsedSession): Json {
  return [
    ...session.warnings,
    ...session.errors,
    ...session.items
      .filter((item) => item.resolutionStatus === "REJECTED")
      .map((item) => ({
        code: "invalid_item",
        message: item.reason ?? "invalid_item",
        sequence: item.sequence,
        reason: item.reason,
      })),
  ] as unknown as Json;
}

function itemsToJson(items: PhysicalInventoryParsedItem[]): Json {
  return items.map((it) => ({
    staff_sequence: it.sequence,
    raw_text: it.rawText,
    raw_product_description: it.rawProductDescription,
    normalized_product: it.normalizedProduct,
    quantity: it.quantity,
    unit_price_satang: it.unitPriceSatang ?? null,
    raw_unit: it.rawUnit,
    normalized_unit: it.normalizedUnit,
    resolution_status: it.resolutionStatus,
    reason: it.reason,
  })) as unknown as Json;
}

function mapRpcError(
  message: string,
  kind: "admit" | "finalize" | "open" | "candidate" | "cancel",
): Error {
  if (message.includes("generation_conflict")) return new PhysicalInventoryGenerationConflictError();
  if (message.includes("session_closed")) return new PhysicalInventoryAfterCloseError();
  if (message.includes("after_close_boundary") || message.includes("deadline_elapsed")) {
    return new PhysicalInventoryAfterCloseBoundaryError(
      message.includes("deadline_elapsed") ? "deadline_elapsed" : "after_close_boundary",
    );
  }
  if (message.includes("line_event_conflict")) return new PhysicalInventoryLineEventConflictError();
  if (message.includes("stale_ingest_revision")) return new PhysicalInventoryStaleRevisionError();
  if (message.includes("stale_ingest_hash")) return new PhysicalInventoryStaleIngestHashError();
  if (message.includes("close_quiet_window")) return new PhysicalInventoryCloseQuietWindowError();
  if (message.includes("close_boundary_required")) {
    return new PhysicalInventoryCloseBoundaryRequiredError();
  }
  return new Error(`${kind} failed: ${message}`);
}

export class PhysicalInventorySessionService {
  constructor(private readonly supabase: Supabase) {}

  async findOpenSession(
    sourceId: string,
    senderLineUserId: string,
  ): Promise<PhysicalInventorySessionRow | null> {
    const sender = senderLineUserId.trim();
    if (!sender) throw new Error("sender_line_user_id required");
    const { data, error } = await this.supabase
      .from("physical_inventory_sessions")
      .select("*")
      .eq("source_id", sourceId)
      .eq("sender_line_user_id", sender)
      .in("status", ["open", "closing"])
      .maybeSingle();
    if (error) throw new Error(`findOpenSession failed: ${error.message}`);
    return data;
  }

  async getSession(sessionId: string): Promise<PhysicalInventorySessionRow | null> {
    const { data, error } = await this.supabase
      .from("physical_inventory_sessions")
      .select("*")
      .eq("id", sessionId)
      .maybeSingle();
    if (error) throw new Error(`getSession failed: ${error.message}`);
    return data;
  }

  /**
   * Atomic open via RPC. Same opened LINE event → idempotent same session.
   */
  async openSession(params: {
    sourceType: "user" | "group" | "room";
    sourceId: string;
    senderLineUserId: string;
    openedLineEventId: string;
    lineTimestampMs: number;
    rawText: string;
    lineMessageId?: string | null;
    rawMessageId?: string | null;
    businessDate?: string | null;
    parserVersion?: string;
  }): Promise<{
    opened: boolean;
    idempotent: boolean;
    reason: string;
    session: PhysicalInventorySessionRow;
  }> {
    const sender = params.senderLineUserId.trim();
    if (!sender) throw new Error("sender_line_user_id required");
    const eventId = params.openedLineEventId.trim();
    if (!eventId) throw new Error("opened_line_event_id required");

    const { data, error } = await this.supabase.rpc("open_physical_inventory_session", {
      p_source_type: params.sourceType,
      p_source_id: params.sourceId,
      p_sender_line_user_id: sender,
      p_opened_line_event_id: eventId,
      p_line_timestamp_ms: params.lineTimestampMs,
      p_raw_text: params.rawText,
      p_line_message_id: params.lineMessageId ?? null,
      p_raw_message_id: params.rawMessageId ?? null,
      p_business_date: params.businessDate ?? null,
      p_parser_version: params.parserVersion ?? PHYSICAL_INVENTORY_PARSER_VERSION,
    });

    if (error) throw mapRpcError(error.message ?? "", "open");

    const row = data as {
      opened: boolean;
      idempotent: boolean;
      reason: string;
      session_id: string;
    };
    const session = await this.getSession(row.session_id);
    if (!session) throw new Error("session missing after open");
    return {
      opened: row.opened,
      idempotent: row.idempotent,
      reason: row.reason,
      session,
    };
  }

  /**
   * Admit a LINE event via RPC (close-boundary aware, globally idempotent).
   */
  async registerIngest(params: {
    sessionId: string;
    expectedGeneration: string;
    lineEventId: string;
    lineTimestampMs: number;
    lineMessageId?: string | null;
    rawMessageId?: string | null;
    kind: "header" | "item" | "close" | "other";
    rawText: string;
  }): Promise<{
    accepted: boolean;
    inserted: boolean;
    reason: string;
    session: PhysicalInventorySessionRow;
  }> {
    const { data, error } = await this.supabase.rpc("admit_physical_inventory_event", {
      p_session_id: params.sessionId,
      p_expected_generation: params.expectedGeneration,
      p_line_event_id: params.lineEventId,
      p_line_timestamp_ms: params.lineTimestampMs,
      p_kind: params.kind,
      p_raw_text: params.rawText,
      p_line_message_id: params.lineMessageId ?? null,
      p_raw_message_id: params.rawMessageId ?? null,
    });

    if (error) throw mapRpcError(error.message ?? "", "admit");

    const row = data as {
      accepted: boolean;
      inserted: boolean;
      reason: string;
      session_id: string;
    };
    const session = await this.getSession(row.session_id);
    if (!session) throw new Error("session missing after admit");
    return {
      accepted: row.accepted,
      inserted: row.inserted,
      reason: row.reason,
      session,
    };
  }

  /** Close a complete document carried by its already-persisted open event. */
  async closeOpenEvent(params: {
    sessionId: string;
    expectedGeneration: string;
    openedLineEventId: string;
  }): Promise<PhysicalInventorySessionRow> {
    const { data, error } = await this.supabase.rpc(
      "close_physical_inventory_open_event",
      {
        p_session_id: params.sessionId,
        p_expected_generation: params.expectedGeneration,
        p_opened_line_event_id: params.openedLineEventId,
      },
    );
    if (error) throw mapRpcError(error.message ?? "", "admit");
    const session = await this.getSession((data as { session_id: string }).session_id);
    if (!session) throw new Error("session missing after inline close");
    return session;
  }

  async getFinalizeCandidate(params: {
    sessionId: string;
    expectedGeneration: string;
  }): Promise<PhysicalInventoryFinalizeCandidate> {
    const { data, error } = await this.supabase.rpc(
      "get_physical_inventory_finalize_candidate",
      {
        p_session_id: params.sessionId,
        p_expected_generation: params.expectedGeneration,
      },
    );
    if (error) throw mapRpcError(error.message ?? "", "candidate");
    const row = data as {
      session_id: string;
      session_generation: string;
      status: PhysicalInventorySessionStatus;
      ingest_revision: number;
      ingest_set_hash: string;
      close_event_timestamp_ms: number | null;
      close_quiet_until: string | null;
      close_deadline_at: string | null;
      ingests: PhysicalInventoryFinalizeCandidate["ingests"];
    };
    return {
      sessionId: row.session_id,
      sessionGeneration: row.session_generation,
      status: row.status,
      ingestRevision: Number(row.ingest_revision),
      ingestSetHash: row.ingest_set_hash,
      closeEventTimestampMs: row.close_event_timestamp_ms,
      closeQuietUntil: row.close_quiet_until,
      closeDeadlineAt: row.close_deadline_at,
      ingests: row.ingests ?? [],
    };
  }

  async listIngestTexts(sessionId: string): Promise<string[]> {
    const { data, error } = await this.supabase
      .from("physical_inventory_session_ingests")
      .select("raw_text, ingest_revision")
      .eq("session_id", sessionId)
      // Close rows are delimiters, not inventory state. A canceled close stays
      // immutable evidence but must not truncate admission-time contradiction
      // checks after the session has been reopened.
      .neq("kind", "close")
      .order("ingest_revision", { ascending: true });
    if (error) throw new Error(`listIngestTexts failed: ${error.message}`);
    return (data ?? []).map((r) => r.raw_text);
  }

  /**
   * Atomic finalize or fail-closed via RPC.
   * Requires CLOSING + quiet/deadline barrier + matching revision+hash.
   * Call getFinalizeCandidate first; parse that exact ingest set; then finalize.
   */
  async finalize(params: {
    sessionId: string;
    expectedGeneration: string;
    expectedIngestRevision: number;
    expectedIngestHash: string;
    parsed: PhysicalInventoryParsedSession;
    failClosed?: boolean;
    failReason?: string;
  }): Promise<{
    ok: boolean;
    idempotent: boolean;
    status: "finalized" | "failed_closed";
    snapshotId: string | null;
    sessionId: string;
    failReason?: string | null;
    itemCount?: number;
    countedAt?: string | null;
    finalizedIngestRevision?: number | null;
    finalizedIngestHash?: string | null;
  }> {
    const hasBlockingParseError = params.parsed.errors.some((e) =>
      ["missing_header", "missing_or_invalid_date", "explicit_empty_conflict"].includes(e.code),
    );
    const explicitEmptyOk =
      params.parsed.explicitEmpty === true
      && params.parsed.items.length === 0
      && Boolean(params.parsed.businessDate)
      && !hasBlockingParseError;
    const failClosed =
      params.failClosed === true ||
      !params.parsed.businessDate ||
      hasBlockingParseError ||
      (params.parsed.items.length === 0 && !explicitEmptyOk);

    const { data, error } = await this.supabase.rpc("finalize_physical_inventory_session", {
      p_session_id: params.sessionId,
      p_expected_generation: params.expectedGeneration,
      p_expected_ingest_revision: params.expectedIngestRevision,
      p_expected_ingest_hash: params.expectedIngestHash,
      p_business_date: params.parsed.businessDate,
      p_parser_version: params.parsed.parserVersion || PHYSICAL_INVENTORY_PARSER_VERSION,
      p_warnings: finalizationWarnings(params.parsed),
      p_items: failClosed ? ([] as unknown as Json) : itemsToJson(params.parsed.items),
      p_fail_closed: failClosed,
      p_fail_reason: failClosed
        ? params.failReason ??
          params.parsed.errors[0]?.code ??
          (!params.parsed.businessDate
            ? "missing_or_invalid_date"
            : hasBlockingParseError
              ? params.parsed.errors[0]?.code ?? "failed_closed"
              : params.parsed.items.length === 0
                ? "no_items"
                : "failed_closed")
        : null,
    });

    if (error) throw mapRpcError(error.message ?? "", "finalize");

    const row = data as {
      ok: boolean;
      idempotent: boolean;
      status: "finalized" | "failed_closed";
      snapshot_id: string | null;
      session_id: string;
      fail_reason?: string | null;
      item_count?: number;
      counted_at?: string | null;
      finalized_ingest_revision?: number | null;
      finalized_ingest_hash?: string | null;
    };

    return {
      ok: row.ok,
      idempotent: row.idempotent,
      status: row.status,
      snapshotId: row.snapshot_id,
      sessionId: row.session_id,
      failReason: row.fail_reason,
      itemCount: row.item_count,
      countedAt: row.counted_at ?? null,
      finalizedIngestRevision: row.finalized_ingest_revision ?? null,
      finalizedIngestHash: row.finalized_ingest_hash ?? null,
    };
  }

  /**
   * Look up the close ingest evidence row an unsent LINE message refers to.
   * Read-only — never mutates evidence. Returns null when the unsent message
   * was not a House Stock close (a header/item unsend, or no match at all).
   */
  async findCloseIngestByLineMessageId(lineMessageId: string): Promise<{
    sessionId: string;
    lineEventId: string;
  } | null> {
    const { data, error } = await this.supabase
      .from("physical_inventory_session_ingests")
      .select("session_id, line_event_id")
      .eq("line_message_id", lineMessageId)
      .eq("kind", "close")
      .maybeSingle();
    if (error) throw new Error(`findCloseIngestByLineMessageId failed: ${error.message}`);
    return data ? { sessionId: data.session_id, lineEventId: data.line_event_id } : null;
  }

  /**
   * Cancel a still-recoverable pending close (LINE unsend of "จบ" before
   * finalize). Atomic + generation-safe via RPC. Never reopens or mutates a
   * finalized/failed_closed/voided session — that case comes back with
   * canceled=false, reason="already_terminal" for the caller to fail closed.
   */
  async cancelClose(params: {
    sessionId: string;
    expectedGeneration: string;
    closeLineEventId: string;
  }): Promise<{
    ok: boolean;
    canceled: boolean;
    reason: string;
    session: PhysicalInventorySessionRow;
  }> {
    const { data, error } = await this.supabase.rpc("cancel_physical_inventory_close", {
      p_session_id: params.sessionId,
      p_expected_generation: params.expectedGeneration,
      p_close_line_event_id: params.closeLineEventId,
    });
    if (error) throw mapRpcError(error.message ?? "", "cancel");
    const row = data as { ok: boolean; canceled: boolean; reason: string; session_id: string };
    const session = await this.getSession(row.session_id);
    if (!session) throw new Error("session missing after cancel close");
    return { ok: row.ok, canceled: row.canceled, reason: row.reason, session };
  }

  async getSnapshot(snapshotId: string): Promise<PhysicalInventorySnapshotRow | null> {
    const { data, error } = await this.supabase
      .from("physical_inventory_snapshots")
      .select("*")
      .eq("id", snapshotId)
      .maybeSingle();
    if (error) throw new Error(`getSnapshot failed: ${error.message}`);
    return data;
  }

  async listSnapshotItems(snapshotId: string): Promise<PhysicalInventoryItemRow[]> {
    const { data, error } = await this.supabase
      .from("physical_inventory_items")
      .select("*")
      .eq("snapshot_id", snapshotId)
      .order("item_ordinal", { ascending: true });
    if (error) throw new Error(`listSnapshotItems failed: ${error.message}`);
    return data ?? [];
  }
}

/** Explicit Slice B boundary: void/supersede admin API is NOT implemented here. */
export const PHYSICAL_INVENTORY_VOID_SUPERSEDE_SLICE = "E" as const;
