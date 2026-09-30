/**
 * Slice 3B — guided capture, review and finalization of an open structured
 * produce session.
 *
 * No parser logic and no barrier logic lives here. Reading the captured items
 * re-uses buildSeedFromStructuredMetadata + parseWeighSession exactly as the
 * deferred finalizer does; closing and confirming go through
 * ProduceSessionCommandService, i.e. close_produce_structured_session and
 * confirm_produce_structured_finalization (0050). This module only reads the
 * session row, refuses what it is not entitled to touch, and shapes the
 * outcome for the LINE layer.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { PendingSessionService } from "@/lib/line/pending-session-service";
import {
  ProduceSessionCommandService,
  produceSessionKey,
  type StructuredPendingSession,
} from "@/lib/line/produce-session-commands";
import { buildSeedFromStructuredMetadata } from "@/lib/parsers/weigh-session/seed";
import {
  getWeighSessionFinalizationErrors,
  parseWeighSession,
} from "@/lib/parsers/weigh-session/parser";
import { resolveGuidedProduceFinalization } from "./produce-finalization";
import {
  runProduceCloseGate,
  type ProduceValidationSessionRef,
} from "@/lib/produce/entry-validation-gate";
import {
  buildBlockingValidationReply,
  buildReviewValidationReply,
} from "@/lib/produce/entry-validation-message";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { bangkokBusinessDateNow } from "@/lib/business-date";
import { produceCommandSourceFromIdentity } from "./session-opener";
import type { GuidedMenuIdentity } from "./ux-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/** Shown when the gate itself could not answer — fail closed, never "fine". */
const GUIDED_ENTRY_GATE_UNAVAILABLE = [
  "ตรวจสอบรายการกับข้อมูลเบิกไม่สำเร็จ",
  "ระบบยังไม่ได้บันทึกอะไร กรุณาลองใหม่อีกครั้ง",
].join("\n");

/** Session identity for the entry gate. Seller and LINE actor stay distinct. */
function entryValidationRef(
  session: StructuredPendingSession,
): ProduceValidationSessionRef {
  return {
    sessionKey: session.session_key,
    sessionGeneration: session.session_generation,
    accountabilityRoundId: session.accountability_round_id ?? null,
    businessDate: session.business_date ?? null,
    marketLabel: session.market_label ?? null,
    staffLabel: session.staff_label ?? null,
    lineUserId: session.line_user_id,
  };
}

/** Why a guided session action could not proceed. Never shown raw to LINE. */
export type GuidedCaptureRefusal =
  | "missing_session_key"
  | "session_key_mismatch"
  | "lookup_failed"
  | "no_open_session"
  | "not_structured"
  | "ownership_conflict"
  | "terminalized";

export type GuidedSessionSnapshot = {
  session: StructuredPendingSession;
  /** Parsed with the session's own frozen seed — the same parse the finalizer runs. */
  parsed: WeighSession;
  /** True once the immutable close boundary has been set. */
  closeRequested: boolean;
};

export type GuidedCaptureStatusOutcome =
  | ({ status: "ok" } & GuidedSessionSnapshot)
  | { status: "refused"; reason: GuidedCaptureRefusal };

export type GuidedCaptureCloseOutcome =
  | ({ status: "closed"; reason: "first_close" | "close_already_requested" } & GuidedSessionSnapshot)
  /**
   * The accumulated items cannot finalize, checked with the SAME validation the
   * finalizer applies. No close boundary was created, so the round stays in
   * capture and corrections are still accepted.
   */
  | ({ status: "validation_failed"; errors: string[]; detail?: string } & GuidedSessionSnapshot)
  /** A confirmable validation review was shown before creating a close boundary. */
  | ({ status: "review_required"; detail: string } & GuidedSessionSnapshot)
  | { status: "refused"; reason: GuidedCaptureRefusal }
  | { status: "conflict"; reason: string; detail?: string };

export type GuidedCaptureFinalizeOutcome =
  /** Produce rows exist — `finalization_status` says so. */
  | ({
      status: "confirmed";
      reason: "confirmed" | "already_confirmed";
      produce: "finalized" | "duplicate";
    } & GuidedSessionSnapshot)
  /**
   * The hold was released and the deferred finalizer has not reported yet.
   * NOT a success: no produce row is proven to exist.
   */
  | ({ status: "finalizing" } & GuidedSessionSnapshot)
  /** Terminal, and not a successful status — the item list was not saved. */
  | ({ status: "finalize_failed"; errors: string[] } & GuidedSessionSnapshot)
  /**
   * The session cannot finalize successfully, checked with the SAME validation
   * the finalizer applies. Refused before the confirm RPC — zero writes.
   */
  | ({ status: "validation_failed"; errors: string[]; detail?: string } & GuidedSessionSnapshot)
  /** A confirmable validation review remains unacknowledged. */
  | ({ status: "review_required"; detail: string } & GuidedSessionSnapshot)
  /** The close barrier says the round is not ready — nothing was released. */
  | {
      status: "not_ready";
      detail?: string;
      admissionCount?: number;
      ingestCount?: number;
      stragglerCount?: number;
    }
  | { status: "refused"; reason: GuidedCaptureRefusal }
  | { status: "conflict"; reason: string; detail?: string };

export class GuidedSessionCaptureService {
  private readonly pending: PendingSessionService;
  private readonly commands: ProduceSessionCommandService;

  constructor(
    private readonly supabase: AnyClient,
    options: {
      pendingService?: PendingSessionService;
      commandService?: ProduceSessionCommandService;
    } = {},
  ) {
    this.pending = options.pendingService ?? new PendingSessionService(supabase);
    this.commands =
      options.commandService ?? new ProduceSessionCommandService(supabase);
  }

  /**
   * Read-only snapshot of the operator's own open guided session.
   *
   * Refuses a legacy (entry_origin IS NULL) row and a row owned by another
   * LINE user before anything is parsed or disclosed.
   */
  async snapshot(
    identity: GuidedMenuIdentity,
  ): Promise<GuidedCaptureStatusOutcome> {
    const source = produceCommandSourceFromIdentity(identity);
    const sessionKey = produceSessionKey(source);
    if (!sessionKey) {
      return { status: "refused", reason: "missing_session_key" };
    }
    if (identity.sessionKey && identity.sessionKey !== sessionKey) {
      return { status: "refused", reason: "session_key_mismatch" };
    }

    const lookup = await this.pending.lookup(sessionKey);
    if (lookup.reason === "db_error") {
      return { status: "refused", reason: "lookup_failed" };
    }
    const row = lookup.session as StructuredPendingSession | null;
    if (!row) return { status: "refused", reason: "no_open_session" };
    if (row.entry_origin == null) {
      return { status: "refused", reason: "not_structured" };
    }
    if (row.line_user_id && row.line_user_id !== identity.lineUserId) {
      return { status: "refused", reason: "ownership_conflict" };
    }
    if (row.terminalized) return { status: "refused", reason: "terminalized" };

    return { status: "ok", ...this.readSnapshot(row) };
  }

  /**
   * จบรายการ — set the immutable close boundary and arm the 0050 hold.
   *
   * The boundary is IMMUTABLE: once `close_produce_structured_session` has run,
   * the round no longer accepts item text, so a validation problem discovered
   * after that point can only be resolved by an administrator. The finalizer's
   * own validation therefore runs FIRST, and an invalid round is refused with no
   * boundary created at all — leaving the operator in capture, where a correction
   * line is still an ordinary append.
   *
   * The identical check at confirm time stays where it is: content can change
   * between the two presses, and a straggler admitted after this call can still
   * make the final parse differ from this one.
   */
  async requestClose(input: {
    identity: GuidedMenuIdentity;
    lineEventId: string;
    lineTimestampMs: number;
  }): Promise<GuidedCaptureCloseOutcome> {
    const current = await this.snapshot(input.identity);
    if (current.status !== "ok") return current;

    // Already closed rounds are past this gate: the boundary exists, and
    // re-answering the same press must stay idempotent rather than start
    // refusing. confirmFinalize is what validates from here on.
    if (!current.closeRequested) {
      const validationErrors = getWeighSessionFinalizationErrors(current.parsed);
      if (validationErrors.length > 0) {
        return {
          status: "validation_failed",
          errors: validationErrors,
          session: current.session,
          parsed: current.parsed,
          closeRequested: current.closeRequested,
        };
      }
      // P4A entry gate. Runs only once the parse itself is sound, so a broken
      // document is still reported as a broken document rather than as a pile
      // of unmatched products.
      //
      // This branch runs before the close boundary, so a validation refusal
      // leaves the same draft open for targeted correction.
      const gate = await this.runEntryGate(current, input.lineEventId);
      if (gate) return gate;
    }

    const result = await this.commands.execute(
      {
        kind: "close",
        lineEventId: input.lineEventId,
        lineTimestampMs: input.lineTimestampMs,
        // The generation the operator's summary was built from. A round that
        // rotated underneath this button must refuse, not close a stranger.
        expectedSessionGeneration: current.session.session_generation,
      },
      produceCommandSourceFromIdentity(input.identity),
    );

    if (!result.ok) {
      return { status: "conflict", reason: result.reason, detail: result.detail };
    }
    if (result.kind !== "close") {
      return { status: "conflict", reason: "unexpected_command_result" };
    }
    return {
      status: "closed",
      reason: result.reason,
      ...this.readSnapshot(result.session),
    };
  }

  /**
   * Release the 0050 finalization hold.
   *
   * Two things this deliberately does NOT do:
   *
   *  - it does not release the hold for a session that cannot finalize. The
   *    same validation the deferred finalizer runs
   *    (`getWeighSessionFinalizationErrors`) is applied first, so a partial
   *    parse or an invalid quantity/unit is refused with zero produce writes
   *    instead of being confirmed and then silently failing;
   *  - it does not report success because the RPC accepted. The produce rows
   *    are written later by `try_finalize_pending_generation`, so the
   *    authoritative row is re-read afterwards and only an explicitly
   *    successful `finalization_status` counts as saved.
   */
  async confirmFinalize(input: {
    identity: GuidedMenuIdentity;
    lineEventId: string;
  }): Promise<GuidedCaptureFinalizeOutcome> {
    const current = await this.snapshot(input.identity);
    if (current.status !== "ok") {
      // A terminalized round is not "no session": pressing confirm again after a
      // successful finalization must report the SAME success, and after a failed
      // one must report the failure — never a generic missing-round reply.
      if (current.reason === "terminalized") {
        return this.produceOutcome(input.identity);
      }
      return current;
    }

    // Pre-confirm gate — the finalizer's own validation, before any write.
    const validationErrors = getWeighSessionFinalizationErrors(current.parsed);
    if (validationErrors.length > 0) {
      return {
        status: "validation_failed",
        errors: validationErrors,
        session: current.session,
        parsed: current.parsed,
        closeRequested: current.closeRequested,
      };
    }

    // P4A entry gate again. Master data can move under a closed round — a
    // withdrawal voided, an additional batch finalized — so the verdict is
    // recomputed here rather than trusted from the close preview.
    //
    // No cancel hint: the close boundary is already written by the time confirm
    // is pressed. Validation copy therefore stays focused on correcting the
    // effective draft, never on abandoning it.
    const gate = await this.runEntryGate(current, input.lineEventId);
    if (gate) return gate;

    const result = await this.commands.execute(
      {
        kind: "confirm",
        lineEventId: input.lineEventId,
        expectedSessionGeneration: current.session.session_generation,
      },
      produceCommandSourceFromIdentity(input.identity),
    );

    if (!result.ok) {
      if (result.reason === "not_ready") {
        return {
          status: "not_ready",
          detail: result.detail,
          admissionCount: result.admission_count,
          ingestCount: result.ingest_count,
          stragglerCount: result.straggler_count,
        };
      }
      return { status: "conflict", reason: result.reason, detail: result.detail };
    }
    if (result.kind !== "confirm") {
      return { status: "conflict", reason: "unexpected_command_result" };
    }

    return this.classifyAfterConfirm(
      input.identity,
      result.session,
      result.reason === "already_confirmed" ? "already_confirmed" : "confirmed",
    );
  }

  /**
   * The P4A entry gate, in the one shape both the close press and the confirm
   * press need: a refusal outcome, or null to carry on.
   *
   * A gate that cannot answer (round master unreadable) refuses. Validating a
   * return against a master we failed to load would pass everything.
   */
  private async runEntryGate(
    current: GuidedSessionSnapshot,
    lineEventId: string,
  ): Promise<
    | ({ status: "validation_failed"; errors: string[]; detail: string } & GuidedSessionSnapshot)
    | ({ status: "review_required"; detail: string } & GuidedSessionSnapshot)
    | null
  > {
    const snapshot = {
      session: current.session,
      parsed: current.parsed,
      closeRequested: current.closeRequested,
    };
    let gate: Awaited<ReturnType<typeof runProduceCloseGate>>;
    try {
      gate = await runProduceCloseGate(
        this.supabase,
        entryValidationRef(current.session),
        current.parsed,
        lineEventId,
      );
    } catch (error) {
      return {
        status: "validation_failed",
        errors: [error instanceof Error ? error.message : "entry validation failed"],
        detail: GUIDED_ENTRY_GATE_UNAVAILABLE,
        ...snapshot,
      };
    }

    if (gate.decision === "blocked") {
      return {
        status: "validation_failed",
        errors: gate.result.blocking.map((exception) => exception.kind),
        detail: buildBlockingValidationReply(gate.result, undefined, current.parsed),
        ...snapshot,
      };
    }
    if (gate.decision === "review_presented") {
      return {
        status: "review_required",
        detail: buildReviewValidationReply(gate.result),
        ...snapshot,
      };
    }
    return null;
  }

  /**
   * Read the produce outcome from the authoritative row.
   *
   * The row returned by the confirm RPC is pre-finalization, so it is re-read
   * once: a finalizer that already completed is reported honestly, and one that
   * has not is reported as still processing rather than as saved.
   */
  private async classifyAfterConfirm(
    identity: GuidedMenuIdentity,
    confirmed: StructuredPendingSession,
    /** The confirm RPC's own verdict; a status re-read reports already_confirmed. */
    confirmReason: "confirmed" | "already_confirmed" = "already_confirmed",
  ): Promise<GuidedCaptureFinalizeOutcome> {
    let row = confirmed;
    const sessionKey = produceSessionKey(
      produceCommandSourceFromIdentity(identity),
    );
    if (sessionKey) {
      const reread = await this.pending.lookup(sessionKey);
      const fresh = reread.session as StructuredPendingSession | null;
      // Only trust a re-read of the same round; a rotated key is not this one.
      if (fresh && fresh.session_generation === confirmed.session_generation) {
        row = fresh;
      }
    }

    const snapshot = this.readSnapshot(row);
    // Success needs a current-generation produce_sessions row, not just a
    // status: a content-hash `duplicate` can point at another generation.
    const outcome = await resolveGuidedProduceFinalization(this.supabase, row);
    if (outcome === "succeeded") {
      return {
        status: "confirmed",
        reason: confirmReason,
        produce: row.finalization_status === "duplicate" ? "duplicate" : "finalized",
        ...snapshot,
      };
    }
    if (outcome === "failed") {
      return {
        status: "finalize_failed",
        // The operator-facing detail comes from the same parse validation, never
        // from finalization_error — no internal detail reaches LINE.
        errors: getWeighSessionFinalizationErrors(snapshot.parsed),
        ...snapshot,
      };
    }
    return { status: "finalizing", ...snapshot };
  }

  /**
   * Re-read the produce outcome for a round whose hold was already released.
   * Used by the status screen so "ดูสถานะ" always reflects the authoritative
   * row rather than whatever the confirm reply happened to say.
   */
  async produceOutcome(
    identity: GuidedMenuIdentity,
  ): Promise<GuidedCaptureFinalizeOutcome> {
    const source = produceCommandSourceFromIdentity(identity);
    const sessionKey = produceSessionKey(source);
    if (!sessionKey) return { status: "refused", reason: "missing_session_key" };
    if (identity.sessionKey && identity.sessionKey !== sessionKey) {
      return { status: "refused", reason: "session_key_mismatch" };
    }
    const lookup = await this.pending.lookup(sessionKey);
    if (lookup.reason === "db_error") {
      return { status: "refused", reason: "lookup_failed" };
    }
    const row = lookup.session as StructuredPendingSession | null;
    if (!row) return { status: "refused", reason: "no_open_session" };
    if (row.entry_origin == null) {
      return { status: "refused", reason: "not_structured" };
    }
    if (row.line_user_id && row.line_user_id !== identity.lineUserId) {
      return { status: "refused", reason: "ownership_conflict" };
    }
    return this.classifyAfterConfirm(identity, row);
  }

  /**
   * Parse the session's accumulated text with its own frozen seed.
   *
   * A seeded parse starts in the item state, so the declared transaction type,
   * seller, market and business date can never be overwritten by operator
   * text. This is a preview of the same parse the finalizer performs; the
   * finalizer's version additionally intersects the admission and ingest
   * ledgers through the close boundary, so a straggler still in flight can
   * make the final result differ from this preview.
   */
  private readSnapshot(row: StructuredPendingSession): GuidedSessionSnapshot {
    const seed = buildSeedFromStructuredMetadata(row);
    const parsed = parseWeighSession(
      row.accumulated_text,
      row.business_date ?? bangkokBusinessDateNow(),
      undefined,
      seed,
    );
    return {
      session: row,
      parsed,
      closeRequested: row.close_event_timestamp_ms !== null,
    };
  }
}
