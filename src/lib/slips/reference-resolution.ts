import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { isVerifiedSlipCheckStatus, normalizeTransactionId } from "./transaction-dedupe";

type Supabase = SupabaseClient<Database>;

/**
 * Manual reference-ID resolution for slip_checks with no extracted reference
 * (BR-02). This is the ONLY write path for a pending check's reference_id —
 * it deliberately does not re-implement any duplicate check itself. Once
 * reference_id is set, the check is picked up by the existing, unchanged
 * global-winner dedupe (resolveGloballyAcceptedCheckIds /
 * aggregateGloballyAcceptedVerifiedTransfers) on its next load, exactly like
 * an AI-extracted reference would be — so a manually supplied duplicate
 * reference cannot count twice.
 *
 * Authorization is enforced by the caller (API route via requireAdminActor)
 * — this function only enforces the data-level invariant that a genuinely
 * pending (NULL reference_id, verified-status) check is what gets resolved.
 */
export class ReferenceResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceResolutionError";
  }
}

export interface ResolveSlipCheckReferenceInput {
  checkId: string;
  referenceId: string;
  actor: string;
}

export interface ResolvedSlipCheckReference {
  checkId: string;
  referenceId: string;
  actor: string;
  resolvedAt: string;
  status?: string;
  reviewReason?: string | null;
}

export async function resolveSlipCheckReference(
  supabase: Supabase,
  input: ResolveSlipCheckReferenceInput,
): Promise<ResolvedSlipCheckReference> {
  const checkId = input.checkId.trim();
  if (!checkId) {
    throw new ReferenceResolutionError("checkId must not be empty");
  }
  const referenceId = normalizeTransactionId(input.referenceId);
  if (!referenceId) {
    throw new ReferenceResolutionError("referenceId must not be empty");
  }
  const actor = input.actor.trim();
  if (!actor) {
    throw new ReferenceResolutionError("actor is required");
  }

  const { data: existing, error: fetchError } = await supabase
    .from("slip_checks")
    .select("id, status, reference_id, failure_reason, slip_type, transaction_time, transfer_amount, paid_amount, gross_amount")
    .eq("id", checkId)
    .maybeSingle();

  if (fetchError) {
    throw new ReferenceResolutionError(`slip check lookup failed: ${fetchError.message}`);
  }
  if (!existing) {
    throw new ReferenceResolutionError(`slip check ${checkId} not found`);
  }
  const heldMissingReference = existing.status === "NEED_REVIEW"
    && existing.failure_reason === "missing_transaction_reference_global";
  if (!isVerifiedSlipCheckStatus(existing.status) && !heldMissingReference) {
    throw new ReferenceResolutionError(
      `slip check ${checkId} is not in a verified status (${existing.status})`,
    );
  }
  if (existing.reference_id !== null) {
    throw new ReferenceResolutionError(
      `slip check ${checkId} already has a reference id — resolution only applies to pending checks`,
    );
  }

  // A held check can only be reinstated after an authorized manual reference
  // and a visible transaction timestamp + positive visible amount. Other
  // NEED_REVIEW categories must never be accepted via this endpoint.
  if (heldMissingReference && (
    !existing.transaction_time
    || !["THAI_HELP_THAI", "GWALLET", "BANK_SLIP_QR", "BANK_SLIP_NO_QR"].includes(existing.slip_type)
    || ![existing.transfer_amount, existing.paid_amount, existing.gross_amount]
      .some((amount) => typeof amount === "number" && Number.isFinite(amount) && amount > 0)
  )) {
    throw new ReferenceResolutionError("held slip needs visible transaction time and positive amount before manual reference resolution");
  }

  // Atomic guard: only succeeds if reference_id is still NULL at write time,
  // so two concurrent resolutions for the same check cannot both apply.
  const { data: updated, error: updateError } = await supabase
    .from("slip_checks")
    .update(heldMissingReference
      ? { reference_id: referenceId, status: "PARTIAL_EXTRACTED", failure_reason: null }
      : { reference_id: referenceId })
    .eq("id", checkId)
    .is("reference_id", null)
    .select("id, status, failure_reason")
    .maybeSingle();

  if (updateError) {
    throw new ReferenceResolutionError(`reference resolution failed: ${updateError.message}`);
  }
  if (!updated) {
    throw new ReferenceResolutionError(
      `slip check ${checkId} was concurrently resolved — retry`,
    );
  }

  const resolvedAt = new Date().toISOString();
  const { error: auditError } = await supabase
    .from("slip_check_reference_resolutions")
    .insert({ check_id: checkId, reference_id: referenceId, actor, created_at: resolvedAt });

  if (auditError) {
    throw new ReferenceResolutionError(`reference resolution audit insert failed: ${auditError.message}`);
  }

  // The global database trigger can still downgrade a manually supplied
  // duplicate reference; report the persisted status, never claim verification.
  return { checkId, referenceId, actor, resolvedAt,
    status: updated.status, reviewReason: updated.failure_reason };
}
