import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;

/**
 * Operator decision on ONE AI slip check (migration 20261102120000).
 *
 * This is the manual approval path for an AI slip — distinct from keying a new
 * manual slip. It never creates a second money row: reconciliation counts the
 * approved amount in place of the AI read, or nothing when rejected. The RPC
 * refuses a check without a reference (BR-02 route first), a duplicate of an
 * earlier verified check, a finalized round, and a second live decision.
 */
export class SlipCheckReviewError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SlipCheckReviewError";
  }
}

const KNOWN_REFUSALS = [
  "slip_check_not_found",
  "slip_check_not_reviewable",
  "slip_check_reference_required",
  "slip_check_is_duplicate",
  "slip_check_round_finalized",
  "slip_reference_credited",
  "slip_check_already_reviewed",
  "slip_check_review_not_active",
  "manual_entry_not_found",
  "manual_entry_session_not_closed",
  "manual_entry_is_ai_slip",
  "manual_entry_is_duplicate",
  "slip_check_superseded_by_manual",
  "slip_check_review_has_dependents",
] as const;

function refusal(message: string): SlipCheckReviewError {
  const code = KNOWN_REFUSALS.find((c) => message.includes(c)) ?? "review_failed";
  return new SlipCheckReviewError(code, message.slice(0, 200));
}

export async function reviewSlipCheck(
  supabase: Supabase,
  input: { checkId: string; decision: "approved" | "rejected"; amount?: number; reason: string; reviewer: string },
): Promise<{ approvalId: string; already: boolean }> {
  const reason = input.reason.trim();
  const reviewer = input.reviewer.trim();
  if (!reason) throw new SlipCheckReviewError("reason_required", "reason is required");
  if (!reviewer) throw new SlipCheckReviewError("reviewer_required", "reviewer is required");
  if (input.decision === "approved" && !(Number.isFinite(input.amount) && (input.amount ?? 0) > 0)) {
    throw new SlipCheckReviewError("amount_required", "an approval needs a positive amount");
  }
  const { data, error } = await supabase.rpc("review_slip_check", {
    p_check_id: input.checkId,
    p_decision: input.decision,
    p_amount: input.decision === "approved" ? Math.round((input.amount ?? 0) * 100) / 100 : null,
    p_reason: reason,
    p_reviewer: reviewer,
  });
  if (error) throw refusal(error.message);
  const result = data as { approval_id: string; already: boolean };
  return { approvalId: result.approval_id, already: result.already };
}

/**
 * Authorized override for ONE manual slip entry (migration 20261102130000):
 * an unreferenced entry in the new flow, or one whose reference conflicts with
 * a REJECTED AI check. Refused when the reference belongs to a live AI check
 * (approve that check instead), while the session is open, or after close.
 */
export async function reviewManualSlipEntry(
  supabase: Supabase,
  input: { entryId: string; decision: "approved" | "rejected"; amount?: number; reason: string; reviewer: string },
): Promise<{ approvalId: string; already: boolean }> {
  const reason = input.reason.trim();
  const reviewer = input.reviewer.trim();
  if (!reason) throw new SlipCheckReviewError("reason_required", "reason is required");
  if (!reviewer) throw new SlipCheckReviewError("reviewer_required", "reviewer is required");
  if (input.decision === "approved" && !(Number.isFinite(input.amount) && (input.amount ?? 0) > 0)) {
    throw new SlipCheckReviewError("amount_required", "an approval needs a positive amount");
  }
  const { data, error } = await supabase.rpc("review_manual_slip_entry", {
    p_entry_id: input.entryId,
    p_decision: input.decision,
    p_amount: input.decision === "approved" ? Math.round((input.amount ?? 0) * 100) / 100 : null,
    p_reason: reason,
    p_reviewer: reviewer,
  });
  if (error) throw refusal(error.message);
  const result = data as { approval_id: string; already: boolean };
  return { approvalId: result.approval_id, already: result.already };
}

export async function revokeSlipCheckReview(
  supabase: Supabase,
  input: { approvalId: string; revokedBy: string; reason: string },
): Promise<void> {
  if (!input.reason.trim() || !input.revokedBy.trim()) {
    throw new SlipCheckReviewError("reason_required", "revoker and reason are required");
  }
  const { error } = await supabase.rpc("revoke_slip_check_review", {
    p_approval_id: input.approvalId,
    p_revoked_by: input.revokedBy.trim(),
    p_reason: input.reason.trim(),
  });
  if (error) throw refusal(error.message);
}
