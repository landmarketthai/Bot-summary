/**
 * P4A — the produce entry validation gate, wired to the database.
 *
 * Reads the round's finalized produce rows, runs the pure gate against the
 * session being closed, and owns the review/override audit. Every read is
 * fail-closed: a master that could not be loaded raises, because validating a
 * return against an empty master would silently declare everything unknown —
 * or, worse, silently declare everything fine.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import {
  validateProduceEntry,
  computeValidationDigest,
  type ProduceValidationResult,
  type ProduceValidationReview,
  type RoundMasterRow,
} from "./entry-validation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

/**
 * A round is one market-day of one seller; a few hundred rows at the outside.
 * Hitting this ceiling means the assumption is wrong, and a truncated master
 * is a wrong master, so it raises instead of validating against a slice.
 */
const MASTER_ROW_LIMIT = 2000;

/** Session identity the gate needs. Never a descriptive tuple. */
export interface ProduceValidationSessionRef {
  sessionKey: string;
  /**
   * The pending generation, as the uuid every generation-scoped table in this
   * schema uses. It stays a string end to end and is never mapped, hashed or
   * numbered — the audit row records the real generation or it audits nothing.
   */
  sessionGeneration: string;
  /** NULL is a legacy/unbound session; the round master is then unavailable. */
  accountabilityRoundId: string | null;
  businessDate: string | null;
  marketLabel: string | null;
  /** The seller the round belongs to — not the person typing. */
  staffLabel: string | null;
  /** The LINE data-entry actor. */
  lineUserId: string | null;
}

export interface ProduceGateEvaluation {
  result: ProduceValidationResult;
  /** True when this exact exception set already carries an explicit confirmation. */
  reviewConfirmed: boolean;
}

export class ProduceValidationGateError extends Error {}

export interface RecordedProduceReview {
  /** True when this exception set already carried an explicit confirmation. */
  confirmed: boolean;
  /**
   * True only once delivery to the operator has been PROVEN. Recording the row
   * does not set it: a LINE reply is a separate call that can fail.
   */
  presentedDelivered: boolean;
  /** The generation is dead; nothing may be recorded or confirmed for it. */
  terminalized: boolean;
  /**
   * The event that first presented this exception set. A later press carrying
   * a different event id is a genuine second press; the same id is a duplicate
   * delivery of the first one and must not be read as an acknowledgement.
   */
  presentedLineEventId: string;
}

/**
 * The round's finalized produce rows.
 *
 * `produce_transactions` already excludes voided sessions (0037), so a
 * replaced session stops contributing to the master the moment it is voided —
 * which is exactly what revalidation before finalization needs.
 */
export async function loadRoundMasterRows(
  supabase: AnyClient,
  accountabilityRoundId: string,
): Promise<RoundMasterRow[]> {
  const { data, error } = await supabase
    .from("produce_transactions")
    .select("product_name, unit, quantity, price_per_unit, transaction_type")
    .eq("accountability_round_id", accountabilityRoundId)
    .limit(MASTER_ROW_LIMIT);

  if (error) {
    throw new ProduceValidationGateError(
      `round withdrawal master could not be read: ${error.message}`,
    );
  }
  const rows = (data ?? []) as RoundMasterRow[];
  if (rows.length >= MASTER_ROW_LIMIT) {
    throw new ProduceValidationGateError(
      "round withdrawal master exceeded the readable row limit",
    );
  }
  return rows;
}

/**
 * Validate a session against its own round, and report whether the resulting
 * review set is already confirmed. Nothing is written here.
 */
export async function evaluateProduceEntryGate(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  parsed: WeighSession,
): Promise<ProduceGateEvaluation> {
  const roundRows = ref.accountabilityRoundId
    ? await loadRoundMasterRows(supabase, ref.accountabilityRoundId)
    : [];

  const result = validateProduceEntry({
    parsed,
    roundRows,
    roundBound: ref.accountabilityRoundId !== null,
    validationIdentity: {
      sessionKey: ref.sessionKey,
      sessionGeneration: ref.sessionGeneration,
      accountabilityRoundId: ref.accountabilityRoundId,
    },
  });

  if (result.reviews.length === 0) {
    return { result, reviewConfirmed: false };
  }
  const subunits = result.reviews.filter((review) => review.kind === "subunit_confirmation");
  const otherReviews = result.reviews.filter((review) => review.kind !== "subunit_confirmation");
  const productConfirmed = otherReviews.length === 0
    || await isReviewConfirmed(supabase, ref, result.digest);
  const subunitsConfirmed = await Promise.all(subunits.map((review) =>
    isReviewConfirmed(supabase, ref, computeValidationDigest(parsed, [], [review], {
      sessionKey: ref.sessionKey,
      sessionGeneration: ref.sessionGeneration,
      accountabilityRoundId: ref.accountabilityRoundId,
    }))));
  return { result, reviewConfirmed: productConfirmed && subunitsConfirmed.every(Boolean) };
}

async function isReviewConfirmed(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  digest: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("produce_entry_validation_reviews")
    .select("confirmed_at")
    .eq("session_key", ref.sessionKey)
    .eq("session_generation", ref.sessionGeneration)
    .eq("validation_digest", digest)
    .maybeSingle();

  if (error) {
    throw new ProduceValidationGateError(
      `validation review lookup failed: ${error.message}`,
    );
  }
  return Boolean(data?.confirmed_at);
}

/**
 * Persist the exception set that is about to be shown to the operator.
 *
 * Idempotent on (session, generation, digest): a duplicate LINE delivery of the
 * same close records nothing new and never resets an existing confirmation.
 */
export async function recordProduceValidationReview(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  result: ProduceValidationResult,
  lineEventId: string,
  parsed?: WeighSession,
): Promise<RecordedProduceReview> {
  if (result.reviews.length === 0) {
    throw new ProduceValidationGateError("no validation review to record");
  }
  if (!ref.lineUserId) {
    throw new ProduceValidationGateError(
      "validation review requires the data-entry LINE actor",
    );
  }

  const { data, error } = await supabase.rpc("record_produce_validation_review", {
    p_session_key: ref.sessionKey,
    p_session_generation: ref.sessionGeneration,
    p_accountability_round_id: ref.accountabilityRoundId,
    p_validation_digest: result.digest,
    p_business_date: ref.businessDate,
    p_market_label: ref.marketLabel,
    p_staff_label: ref.staffLabel,
    p_exceptions: result.reviews,
    p_line_user_id: ref.lineUserId,
    p_line_event_id: lineEventId,
  });

  if (error) {
    throw new ProduceValidationGateError(
      `validation review could not be recorded: ${error.message}`,
    );
  }
  const row = (data ?? {}) as {
    status?: string;
    confirmed?: boolean;
    presented_line_event_id?: string | null;
    presented_delivered?: boolean;
  };
  if (row.status === "terminalized") {
    return {
      confirmed: false,
      presentedDelivered: false,
      terminalized: true,
      presentedLineEventId: lineEventId,
    };
  }
  // Risky subunits are independently confirmable. Keep the full review row
  // for existing product-vocabulary behavior, and add one row per item.
  if (parsed) for (const review of result.reviews.filter((entry) => entry.kind === "subunit_confirmation")) {
    const itemDigest = computeValidationDigest(parsed, [], [review], {
      sessionKey: ref.sessionKey,
      sessionGeneration: ref.sessionGeneration,
      accountabilityRoundId: ref.accountabilityRoundId,
    });
    const itemRecord = await supabase.rpc("record_produce_validation_review", {
      p_session_key: ref.sessionKey,
      p_session_generation: ref.sessionGeneration,
      p_accountability_round_id: ref.accountabilityRoundId,
      p_validation_digest: itemDigest,
      p_business_date: ref.businessDate,
      p_market_label: ref.marketLabel,
      p_staff_label: ref.staffLabel,
      p_exceptions: [review],
      p_line_user_id: ref.lineUserId,
      p_line_event_id: lineEventId,
    });
    if (itemRecord.error) throw new ProduceValidationGateError(
      `subunit validation review could not be recorded: ${itemRecord.error.message}`,
    );
  }
  return {
    confirmed: Boolean(row.confirmed),
    presentedDelivered: row.presented_delivered === true,
    terminalized: false,
    presentedLineEventId: row.presented_line_event_id ?? lineEventId,
  };
}

export type ProduceCloseGateDecision =
  /** Nothing stands in the way of creating the close boundary. */
  | { decision: "proceed"; result: ProduceValidationResult }
  /** Impossible or unidentifiable data. Never confirmable — it has to be corrected. */
  | { decision: "blocked"; result: ProduceValidationResult }
  /** Confirmable review exceptions await a second, explicit press. */
  | { decision: "review_presented"; result: ProduceValidationResult };

/**
 * The gate as it runs on "จบรายการ".
 *
 * No close boundary exists yet at this point, which is the whole reason the
 * gate lives here: a refusal leaves the round in capture, where a corrected
 * line is still an ordinary item message. Confirmable reviews use two presses
 * of the same button — the first shows the exceptions and records them, the
 * second (a different LINE event, so a duplicate delivery can never stand in
 * for it) acknowledges exactly the exception set that was shown.
 */
export async function runProduceCloseGate(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  parsed: WeighSession,
  lineEventId: string,
): Promise<ProduceCloseGateDecision> {
  const { result, reviewConfirmed } = await evaluateProduceEntryGate(supabase, ref, parsed);
  if (result.status === "blocked") return { decision: "blocked", result };
  if (result.status === "clean" || reviewConfirmed) return { decision: "proceed", result };

  const recorded = await recordProduceValidationReview(supabase, ref, result, lineEventId, parsed);
  if (recorded.confirmed) {
    // The legacy whole-review row may be acknowledged by the second close;
    // risky subunit rows still have to be checked independently.
    if (result.reviews.some((review) => review.kind === "subunit_confirmation")) {
      const current = await evaluateProduceEntryGate(supabase, ref, parsed);
      if (!current.reviewConfirmed) return { decision: "review_presented", result: current.result };
    }
    return { decision: "proceed", result };
  }
  if (recorded.presentedLineEventId === lineEventId) {
    return { decision: "review_presented", result };
  }

  const confirmation = await confirmProduceValidationReview(
    supabase,
    ref,
    result.digest,
    lineEventId,
  );
  // Only confirmed/already_confirmed authorize. not_found (stale digest),
  // not_presented (recorded but never proven delivered — the finalizer's push
  // failed) and terminalized all mean re-present, never approve. record_ above
  // has just marked this reply as the delivery, so the NEXT distinct close can
  // confirm it.
  if (!isProduceReviewApproved(confirmation)) {
    return { decision: "review_presented", result };
  }
  if (result.reviews.some((review) => review.kind === "subunit_confirmation")) {
    const current = await evaluateProduceEntryGate(supabase, ref, parsed);
    if (!current.reviewConfirmed) return { decision: "review_presented", result: current.result };
  }
  return { decision: "proceed", result };
}

/**
 * The gate as it runs on every step after the close boundary exists — the
 * confirm press and the deferred finalizer.
 *
 * Read-only and unforgiving: it never presents and never confirms. Master data
 * can change under a closed round (a voided withdrawal, a later additional
 * batch), so the verdict is recomputed from live data every time and an
 * approval that no longer matches the data is simply not an approval.
 */
export async function runProduceFinalizeGate(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  parsed: WeighSession,
): Promise<ProduceCloseGateDecision> {
  const { result, reviewConfirmed } = await evaluateProduceEntryGate(supabase, ref, parsed);
  if (result.status === "blocked") return { decision: "blocked", result };
  if (result.status === "clean" || reviewConfirmed) return { decision: "proceed", result };
  return { decision: "review_presented", result };
}

/**
 * `not_found`   — the digest no longer describes the session (stale press).
 * `not_presented` — recorded but never proven delivered to the operator; the
 *                 caller must re-present, never approve.
 * `terminalized` — the generation is dead; nothing about it can be approved.
 *
 * Only `confirmed` and `already_confirmed` are approvals. Everything else means
 * re-present.
 */
export type ProduceReviewConfirmation =
  | "confirmed"
  | "already_confirmed"
  | "not_found"
  | "not_presented"
  | "terminalized";

const REVIEW_CONFIRMATION_STATUSES: ReadonlySet<string> = new Set<ProduceReviewConfirmation>([
  "confirmed",
  "already_confirmed",
  "not_found",
  "not_presented",
  "terminalized",
]);

/** True only for a status that actually authorizes the exception set. */
export function isProduceReviewApproved(status: ProduceReviewConfirmation): boolean {
  return status === "confirmed" || status === "already_confirmed";
}

/**
 * A stable, deterministic presentation identity for a review the finalizer
 * discovered. Generation- and digest-bound, identical across retries of the
 * same decision, and prefixed so it can never collide with a real LINE event
 * id — which is what stops a redelivered event from self-confirming.
 */
export function finalizerPresentationToken(
  sessionGeneration: string,
  digest: string,
): string {
  return `finalizer:${sessionGeneration}:${digest}`;
}

/** Confirm exactly one currently parsed risky-subunit item. */
export async function confirmProduceSubunitReview(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  parsed: WeighSession,
  itemNumber: number,
  lineEventId: string,
): Promise<ProduceReviewConfirmation> {
  const roundRows = ref.accountabilityRoundId
    ? await loadRoundMasterRows(supabase, ref.accountabilityRoundId)
    : [];
  const result = validateProduceEntry({
    parsed,
    roundRows,
    roundBound: ref.accountabilityRoundId !== null,
    validationIdentity: {
      sessionKey: ref.sessionKey,
      sessionGeneration: ref.sessionGeneration,
      accountabilityRoundId: ref.accountabilityRoundId,
    },
  });
  const review = result.reviews.find((entry) =>
    entry.kind === "subunit_confirmation" && entry.itemNumber === itemNumber);
  if (!review || result.reviews.filter((entry) => entry.kind === "subunit_confirmation"
    && entry.itemNumber === itemNumber).length !== 1) return "not_found";
  return confirmProduceValidationReview(
    supabase,
    ref,
    computeValidationDigest(parsed, [], [review], {
      sessionKey: ref.sessionKey,
      sessionGeneration: ref.sessionGeneration,
      accountabilityRoundId: ref.accountabilityRoundId,
    }),
    lineEventId,
  );
}

/**
 * Acknowledge the exception set identified by `digest`.
 *
 * `not_found` means the digest on the button no longer describes the session —
 * a stale press, or a straggler that changed the document after the preview.
 * The caller re-presents; it must never treat that as an approval.
 */
export async function confirmProduceValidationReview(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  digest: string,
  lineEventId: string,
): Promise<ProduceReviewConfirmation> {
  if (!ref.lineUserId) {
    throw new ProduceValidationGateError(
      "validation confirmation requires the data-entry LINE actor",
    );
  }
  const { data, error } = await supabase.rpc("confirm_produce_validation_review", {
    p_session_key: ref.sessionKey,
    p_session_generation: ref.sessionGeneration,
    p_validation_digest: digest,
    p_line_user_id: ref.lineUserId,
    p_line_event_id: lineEventId,
  });

  if (error) {
    throw new ProduceValidationGateError(
      `validation confirmation failed: ${error.message}`,
    );
  }
  const status = (data as { status?: string } | null)?.status;
  if (status !== undefined && REVIEW_CONFIRMATION_STATUSES.has(status)) {
    return status as ProduceReviewConfirmation;
  }
  throw new ProduceValidationGateError("validation confirmation returned an unknown status");
}

/**
 * Record the review the finalizer discovered after the close boundary, WITHOUT
 * claiming it was shown. Delivery is proven separately, only once the LINE push
 * has actually succeeded, so nothing can confirm it in the meantime.
 */
export async function recordFinalizerValidationReview(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  result: ProduceValidationResult,
  presentationToken: string,
): Promise<{ recorded: boolean; alreadyDelivered: boolean }> {
  // Same recorder as the webhook: recording never claims delivery, so there is
  // no second implementation that could drift from this one. The synthetic
  // token stands in for the presenting event id until a successful push
  // rebinds it.
  const row = await recordProduceValidationReview(supabase, ref, result, presentationToken);
  return { recorded: !row.terminalized, alreadyDelivered: row.presentedDelivered };
}

/**
 * The digests one LINE message is entitled to authorize.
 *
 * Built ONLY from reviews the message actually rendered. The whole-review digest
 * is included only when every review was shown: it authorizes the entire set, so
 * a truncated message must not carry it. Each rendered risky-subunit review
 * contributes its own item digest, because #109 confirms those individually.
 */
export function reviewPresentationDigests(
  ref: ProduceValidationSessionRef,
  result: ProduceValidationResult,
  presentation: { renderedReviews: ProduceValidationReview[]; complete: boolean },
  parsed?: WeighSession,
): string[] {
  const digests: string[] = [];
  if (presentation.complete) digests.push(result.digest);

  if (parsed) {
    for (const review of presentation.renderedReviews) {
      if (review.kind !== "subunit_confirmation") continue;
      digests.push(computeValidationDigest(parsed, [], [review], {
        sessionKey: ref.sessionKey,
        sessionGeneration: ref.sessionGeneration,
        accountabilityRoundId: ref.accountabilityRoundId,
      }));
    }
  }
  return [...new Set(digests)];
}

/**
 * The digests a set of DELIVERED presentation pages may authorize.
 *
 * Per-item subunit digests come from every page that was actually delivered, so
 * a partly delivered sequence still tells the truth about the items the
 * operator really saw. The whole-review digest is added only when `complete` —
 * every exception in the set was delivered — because that one digest authorizes
 * all of them.
 */
export function deliveredPresentationDigests(
  ref: ProduceValidationSessionRef,
  result: ProduceValidationResult,
  deliveredPages: readonly { renderedReviews: ProduceValidationReview[] }[],
  complete: boolean,
  parsed?: WeighSession,
): string[] {
  const digests: string[] = [];
  if (complete) digests.push(result.digest);

  if (parsed) {
    for (const page of deliveredPages) {
      for (const review of page.renderedReviews) {
        if (review.kind !== "subunit_confirmation") continue;
        digests.push(computeValidationDigest(parsed, [], [review], {
          sessionKey: ref.sessionKey,
          sessionGeneration: ref.sessionGeneration,
          accountabilityRoundId: ref.accountabilityRoundId,
        }));
      }
    }
  }
  return [...new Set(digests)];
}

/**
 * Prove that ONE LINE message reached the operator, for every review row it
 * actually rendered. All-or-nothing: a message is one thing the operator saw,
 * so it cannot half-authorize.
 */
export async function markProduceValidationReviewsPresented(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  digests: readonly string[],
  presentedLineEventId: string,
): Promise<{ status: string; marked: number }> {
  if (digests.length === 0) return { status: "no_digests", marked: 0 };
  const { data, error } = await supabase.rpc("mark_produce_validation_reviews_presented", {
    p_session_key: ref.sessionKey,
    p_session_generation: ref.sessionGeneration,
    p_validation_digests: [...digests],
    p_presented_line_event_id: presentedLineEventId,
  });
  if (error) {
    throw new ProduceValidationGateError(
      `validation review presentation could not be recorded: ${error.message}`,
    );
  }
  const row = (data ?? {}) as { status?: string; marked?: number };
  return { status: row.status ?? "unknown", marked: row.marked ?? 0 };
}

export type ReviewPresentationStatus =
  | "presented"
  | "already_presented"
  | "not_found"
  | "terminalized"
  | "invalid_presentation_event";

/**
 * Prove this exact review reached the operator.
 *
 * Call ONLY after the LINE reply or push actually succeeded — this is the sole
 * writer of delivery proof, and `presented_delivered_at IS NOT NULL` has exactly
 * one meaning because of that.
 *
 * `presentedLineEventId` is the event that CAUSED the proven presentation, and
 * it becomes the row's stored presenting identity. When a first close recorded
 * the row but its reply failed, a later close that re-presents successfully
 * takes ownership — otherwise a duplicate delivery of that later close would
 * look like a distinct event and self-confirm.
 */
export async function markProduceValidationReviewPresented(
  supabase: AnyClient,
  ref: ProduceValidationSessionRef,
  digest: string,
  presentedLineEventId: string,
): Promise<ReviewPresentationStatus> {
  const { data, error } = await supabase.rpc("mark_produce_validation_review_presented", {
    p_session_key: ref.sessionKey,
    p_session_generation: ref.sessionGeneration,
    p_validation_digest: digest,
    p_presented_line_event_id: presentedLineEventId,
  });
  if (error) {
    throw new ProduceValidationGateError(
      `validation review presentation could not be recorded: ${error.message}`,
    );
  }
  const status = (data as { status?: string } | null)?.status;
  if (
    status === "presented" || status === "already_presented"
    || status === "not_found" || status === "terminalized"
    || status === "invalid_presentation_event"
  ) {
    return status;
  }
  throw new ProduceValidationGateError("review presentation returned an unknown status");
}
