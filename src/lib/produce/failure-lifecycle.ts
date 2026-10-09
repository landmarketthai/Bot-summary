/**
 * Produce failure lifecycle — is an old failed attempt still a live problem?
 *
 * Production 2026-08 keeps every refused document forever, and every report
 * read that absence of success as an unresolved accountability issue. Two of
 * the four situations behind such a row are already closed business:
 *
 *   the seller re-sent a corrected document and it landed          (superseded)
 *   the round the attempt belonged to was retired by the successor (abandoned)
 *
 * The other two are real:
 *
 *   nothing ever replaced it                                    (active_failed)
 *   more than one document could be the replacement          (active + ambiguous)
 *
 * This module owns that decision and NOTHING else. It is pure: no database, no
 * clock, no writes. Everything it needs is passed in, so every rule below is
 * unit-testable without Production data.
 *
 * FAIL CLOSED is the whole design. A failure is only ever downgraded when a
 * specific successful document can be POINTED AT. Missing identity, missing
 * timestamps, an unprovable ordering or two candidate successors all leave the
 * failure exactly where it was: active, visible, blocking the day.
 */

import { canonicalMarketLabel } from "@/lib/market";
import type { TransactionBucket } from "@/lib/summary/transactions";

/**
 * `active_failed` unresolved; must affect report readiness.
 * `superseded`    a later successful document carries the same operational
 *                 intent. Kept for audit, never alerted on.
 * `abandoned`     an authorized workflow retired it (a cancelled accountability
 *                 round). Kept for audit, never alerted on.
 */
export type ProduceFailureState = "active_failed" | "superseded" | "abandoned";

/** Where the failed attempt is recorded. Both are audit evidence, never deleted. */
export type ProduceFailureOrigin = "pending_session" | "raw_message";

/**
 * One refused/unfinalized produce document, reduced to the identity dimensions
 * supersession is allowed to reason about.
 *
 * Every field is nullable because Production really does contain rows missing
 * each of them — and a null is never treated as a wildcard match. It is treated
 * as "cannot prove", which keeps the attempt active.
 */
export interface ProduceFailureAttempt {
  attemptId: string;
  origin: ProduceFailureOrigin;
  /** The business date the document's OWN evidence names, not its insert time. */
  businessDate: string | null;
  /**
   * P0-D: an undated document whose first LINE event sits near the 04:00
   * cutoff may belong to the adjacent business day as well. It is reported on
   * both days, and a replacement landing on EITHER day supersedes it.
   */
  alternateBusinessDate?: string | null;
  /** LINE source (group) that owns the document. */
  sourceId: string | null;
  /** The seller the produce belongs to — not the person typing. */
  staffLabel: string | null;
  /** Market label as written. Compared normalized, never fuzzily. */
  marketLabel: string | null;
  /** เบิก / คืน / คืนเสีย. Null when the document declares more than one. */
  transactionKind: TransactionBucket | null;
  accountabilityRoundId: string | null;
  /** LINE event time of the attempt. Null makes ordering unprovable. */
  attemptedAtMs: number | null;
  /**
   * The document text, when the adapter still has it. Not an identity
   * dimension and never used for supersession. Purchase Planning reads it to
   * scope an unattributable เบิก to the products the text actually names.
   */
  sourceText?: string | null;
}

/** One produce document that actually landed — a candidate replacement. */
export interface FinalizedProduceOutcome {
  produceSessionId: string;
  businessDate: string | null;
  sourceId: string | null;
  staffLabel: string | null;
  marketLabel: string | null;
  transactionKind: TransactionBucket | null;
  accountabilityRoundId: string | null;
  /**
   * "main" | "additional". Only a MAIN session can replace a failed attempt:
   * an additional batch (เบิกเพิ่ม / ชั่งคืนเพิ่ม) is additive by contract, so
   * treating one as a replacement would silently drop the original intent.
   */
  sessionKind: string | null;
  /** Defensive audit field; loaders already exclude voided rows. */
  voidedAtMs?: number | null;
  finalizedAtMs: number | null;
}

export interface ProduceFailureClassification {
  attemptId: string;
  state: ProduceFailureState;
  /** The document that replaced it. Null unless `state` is "superseded". */
  supersededByProduceSessionId: string | null;
  /**
   * More than one finalized document matched this attempt's intent. The
   * attempt stays ACTIVE and this is surfaced as an integrity issue — picking
   * one of two successors is exactly the guess this layer must never make.
   */
  ambiguousSuccessor: boolean;
}

export interface ProduceFailureContext {
  /** Rounds an authorized workflow retired (accountability_rounds.status). */
  cancelledRoundIds?: ReadonlySet<string>;
}

/** Identity comparison boundary: NFC + trimmed + inner whitespace collapsed. */
function identityText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.normalize("NFC").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * True when `outcome` is a provable replacement for `attempt`.
 *
 * EVERY business identity dimension must match explicitly: source, business
 * date, market, seller and transaction kind. A bound attempt additionally
 * requires its exact accountability round. An unbound attempt has no round
 * identity to compare, so a bound successor may replace it only through the
 * complete business-identity path above. A round id never excuses a
 * mismatching seller/market/source/date.
 *
 * Replacement also requires strict ordering: a document that landed BEFORE the failed
 * attempt cannot be its correction.
 */
function isSuccessorOf(
  attempt: ProduceFailureAttempt,
  outcome: FinalizedProduceOutcome,
): boolean {
  // Only a proven main batch is a replacement. Null is unknown, not legacy-main.
  if (outcome.sessionKind !== "main") return false;
  if (outcome.voidedAtMs != null) return false;

  const kind = attempt.transactionKind;
  if (!kind || outcome.transactionKind !== kind) return false;

  if (attempt.attemptedAtMs === null || outcome.finalizedAtMs === null) return false;
  if (outcome.finalizedAtMs <= attempt.attemptedAtMs) return false;

  const source = identityText(attempt.sourceId);
  const date = identityText(attempt.businessDate);
  const market = identityText(attempt.marketLabel);
  const staff = identityText(attempt.staffLabel);
  if (!source || !date || !market || !staff) return false;

  if (
    identityText(outcome.sourceId) !== source
    || identityText(outcome.businessDate) !== date
    || identityText(outcome.marketLabel) !== market
    || identityText(outcome.staffLabel) !== staff
  ) return false;

  // A known round is authoritative and must match exactly. A raw/unbound
  // attempt has no round dimension, so null is not treated as a wildcard over
  // partial identity: it is allowed only after every business dimension above
  // has been proven equal.
  const attemptRound = identityText(attempt.accountabilityRoundId);
  return (
    attemptRound === null
    || identityText(outcome.accountabilityRoundId) === attemptRound
  );
}

/** Classify one failed attempt against every finalized document of the day. */
export function classifyProduceFailure(
  attempt: ProduceFailureAttempt,
  outcomes: readonly FinalizedProduceOutcome[],
  context: ProduceFailureContext = {},
): ProduceFailureClassification {
  const round = identityText(attempt.accountabilityRoundId);
  if (round && context.cancelledRoundIds?.has(round)) {
    // A retired round is a decision an authorized workflow already made (see
    // migration 20260811090000: the successor terminalizes its predecessor).
    return {
      attemptId: attempt.attemptId,
      state: "abandoned",
      supersededByProduceSessionId: null,
      ambiguousSuccessor: false,
    };
  }

  const successors = outcomes.filter((outcome) => isSuccessorOf(attempt, outcome));
  if (successors.length === 1) {
    return {
      attemptId: attempt.attemptId,
      state: "superseded",
      supersededByProduceSessionId: successors[0].produceSessionId,
      ambiguousSuccessor: false,
    };
  }

  if (successors.length === 0) {
    const released = laterReturnOnEveryCandidateRound(attempt, outcomes);
    if (released) {
      return {
        attemptId: attempt.attemptId,
        state: "superseded",
        supersededByProduceSessionId: released,
        ambiguousSuccessor: false,
      };
    }
  }

  return {
    attemptId: attempt.attemptId,
    state: "active_failed",
    supersededByProduceSessionId: null,
    ambiguousSuccessor: successors.length > 1,
  };
}

/**
 * P0: release an UNBOUND refused return whose identity text drifted (a
 * mistyped market is the usual reason a close is refused, and the corrected
 * resend then never matches it exactly).
 *
 * The candidate rounds are the day's withdrawal masters (landed เบิก main
 * batches with a round), narrowed exactly as the report protects them: by
 * source, then seller, then canonical market, each only where some candidate
 * shares the value. The attempt is released only when EVERY candidate round
 * received a later main return of the same kind. A seller who runs several
 * markets keeps the failure until each of them has its return; a real market
 * named by the failure narrows to that market alone, so another market's
 * return never clears it. Withdrawals, bound attempts and unknown kinds are
 * never released this way.
 */
function laterReturnOnEveryCandidateRound(
  attempt: ProduceFailureAttempt,
  outcomes: readonly FinalizedProduceOutcome[],
): string | null {
  if (identityText(attempt.accountabilityRoundId) !== null) return null;
  const kind = attempt.transactionKind;
  if (kind !== "คืน" && kind !== "คืนเสีย") return null;
  const date = identityText(attempt.businessDate);
  if (!date || attempt.attemptedAtMs === null) return null;
  const attemptedAtMs = attempt.attemptedAtMs;

  const masters = new Map<string, FinalizedProduceOutcome>();
  for (const outcome of outcomes) {
    const round = identityText(outcome.accountabilityRoundId);
    if (
      round && outcome.voidedAtMs == null && outcome.transactionKind === "เบิก"
      && outcome.sessionKind === "main" && identityText(outcome.businessDate) === date
    ) masters.set(round, outcome);
  }
  let candidates = [...masters.entries()];
  const source = identityText(attempt.sourceId);
  const staff = identityText(attempt.staffLabel);
  const market = canonicalMarketLabel(attempt.marketLabel);
  for (const matches of [
    ([, master]: [string, FinalizedProduceOutcome]) => source !== null && identityText(master.sourceId) === source,
    ([, master]: [string, FinalizedProduceOutcome]) => staff !== null && identityText(master.staffLabel) === staff,
    ([, master]: [string, FinalizedProduceOutcome]) => market !== "" && canonicalMarketLabel(master.marketLabel) === market,
  ]) {
    const narrowed = candidates.filter(matches);
    if (narrowed.length > 0) candidates = narrowed;
  }
  if (candidates.length === 0) return null;

  let released: string | null = null;
  for (const [round] of candidates) {
    const later = outcomes.find((outcome) =>
      identityText(outcome.accountabilityRoundId) === round
      && outcome.sessionKind === "main" && outcome.voidedAtMs == null
      && outcome.transactionKind === kind
      && outcome.finalizedAtMs !== null && outcome.finalizedAtMs > attemptedAtMs);
    if (!later) return null;
    released ??= later.produceSessionId;
  }
  return released;
}

export function classifyProduceFailures(
  attempts: readonly ProduceFailureAttempt[],
  outcomes: readonly FinalizedProduceOutcome[],
  context: ProduceFailureContext = {},
): ProduceFailureClassification[] {
  return attempts.map((attempt) => classifyProduceFailure(attempt, outcomes, context));
}

/** The attempt ids that still count as unresolved. */
export function activeFailureIds(
  classifications: readonly ProduceFailureClassification[],
): Set<string> {
  return new Set(
    classifications.filter((row) => row.state === "active_failed").map((row) => row.attemptId),
  );
}

/** Bound rounds with a still-active return/damage attempt. */
export function activeIncompleteReturnRoundIds(
  attempts: readonly ProduceFailureAttempt[],
  classifications: readonly ProduceFailureClassification[],
): Set<string> {
  const active = activeFailureIds(classifications);
  return new Set(
    attempts
      .filter(
        (attempt) =>
          active.has(attempt.attemptId)
          && attempt.transactionKind !== null
          && attempt.transactionKind !== "เบิก"
          && identityText(attempt.accountabilityRoundId) !== null,
      )
      .map((attempt) => identityText(attempt.accountabilityRoundId) as string),
  );
}
