import { loadReferenceIndex } from "@/lib/slips/reference-ownership";
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
    .select("id, status, reference_id")
    .eq("id", checkId)
    .maybeSingle();

  if (fetchError) {
    throw new ReferenceResolutionError(`slip check lookup failed: ${fetchError.message}`);
  }
  if (!existing) {
    throw new ReferenceResolutionError(`slip check ${checkId} not found`);
  }
  if (!isVerifiedSlipCheckStatus(existing.status)) {
    throw new ReferenceResolutionError(
      `slip check ${checkId} is not in a verified status (${existing.status})`,
    );
  }
  if (existing.reference_id !== null) {
    throw new ReferenceResolutionError(
      `slip check ${checkId} already has a reference id — resolution only applies to pending checks`,
    );
  }

  // An operator decision (slip_check_approvals) on another AI read or manual
  // entry of this reference fixes who owns its money; giving the reference to
  // this check could silently take that money over (it may be earlier, i.e.
  // the new global winner). Refuse; the reviewer revokes that decision first.
  const index = await loadReferenceIndex(supabase, [referenceId]);
  const ai = index.ai.get(referenceId);
  const manuals = index.manual.get(referenceId) ?? [];
  if (ai?.decision || manuals.some((m) => m.decision)) {
    throw new ReferenceResolutionError(
      `reference ${referenceId} already has a reviewed slip — revoke that decision before reassigning it`,
    );
  }

  // Atomic guard: only succeeds if reference_id is still NULL at write time,
  // so two concurrent resolutions for the same check cannot both apply.
  const { data: updated, error: updateError } = await supabase
    .from("slip_checks")
    .update({ reference_id: referenceId })
    .eq("id", checkId)
    .is("reference_id", null)
    .select("id")
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

  return { checkId, referenceId, actor, resolvedAt };
}
