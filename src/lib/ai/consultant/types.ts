/**
 * Shared contract for the @Botsummary AI Consultant (Phase 1–3).
 *
 * Facts come from deterministic backend code; the LLM only phrases them.
 * Nothing in this module (or anything it feeds) writes to the database.
 */

import type { RuntimeEnvironment } from "@/lib/runtime-environment";

/**
 * Who is asking, taken ONLY from the signed LINE webhook event — never from
 * the question text and never from model-generated tool arguments.
 */
export interface ConsultantRequester {
  sourceId: string;
  lineUserId: string;
  sourceType: "group" | "room" | "user";
}

/**
 * What the requester may read. Resolved server-side before any query runs.
 *
 * `own`        rows whose pending_sessions.line_user_id is the requester AND
 *              whose source_id is the chat the question was asked in.
 * `supervisor` any row whose source_id is in `sourceIds` (the consultant's
 *              allowlisted chats). Granted only by an explicit env allowlist
 *              of LINE user ids.
 */
export type ConsultantScope =
  | {
      kind: "own";
      lineUserId: string;
      sourceId: string;
      /** Trusted label from line_operator_identities, when mapped. */
      staffLabel: string | null;
      runtimeEnvironment: RuntimeEnvironment;
    }
  | {
      kind: "supervisor";
      lineUserId: string;
      sourceIds: readonly string[];
      staffLabel: string | null;
      runtimeEnvironment: RuntimeEnvironment;
    };

/**
 * Lifecycle of one Produce document (เบิก / ชั่งคืน / คืนเสีย), as proven by
 * stored evidence. A LINE message being received is NOT persistence.
 */
export type SubmissionLifecycleState =
  /** Draft open, lines arriving, no close yet. */
  | "capturing"
  /** Draft open and some lines need correction before it can close. */
  | "needs_correction"
  /** Close was sent and refused; the correction window is still open. */
  | "close_refused_correctable"
  /** Structured review hold: waiting for the operator to confirm. */
  | "awaiting_confirmation"
  /** Close accepted; the finalizer has not finished yet. */
  | "finalization_pending"
  /** Finalized and the produce session row exists. */
  | "finalized"
  /** Closed as a duplicate of a document that is already saved. */
  | "duplicate_already_saved"
  /** Terminal failure: the round closed without saving. Needs an admin. */
  | "failed_terminal"
  /** Expired with zero accepted lines: nothing was ever entered. */
  | "expired_empty"
  /** Cancelled by the operator or superseded by a newer document. */
  | "cancelled_or_superseded"
  /** Evidence is missing or contradictory. Never guess. */
  | "unknown";

/**
 * Next steps the system ACTUALLY supports. Each id must map to a verified
 * knowledge entry (see knowledge.ts) — the consultant never invents one.
 */
export type ConsultantActionId =
  | "correct_item_in_open_draft"
  | "remove_item_in_open_draft"
  | "send_close_again"
  | "confirm_review"
  | "wait_for_finalization"
  | "contact_admin_recovery"
  | "nothing_needed"
  | "start_new_document";
