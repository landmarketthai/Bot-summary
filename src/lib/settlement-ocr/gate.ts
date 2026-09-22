import type { GuidedJourneyState } from "@/lib/line/guided-menu/journey";

/**
 * The ONLY trigger for settlement-sheet OCR: the sender's OWN guided round
 * must already be past the White Sheet step (whiteSheet is proven submitted
 * — see journey.ts's stage derivation, where "white_sheet" is returned
 * exactly when it is not) and not still finalizing produce. This is the
 * SAME window in which a typed "ส่งยอด" guided command would already be
 * accepted (see settlement-command.ts's own stage checks) — OCR does not
 * open any window a typed command could not already use.
 *
 * Deliberately conservative: outside this window (no guided round, or a
 * round that has not reached this step yet) an incoming photo is left
 * completely alone, exactly like today — see gate usage in
 * webhook-service.ts, which only calls the settlement-sheet pipeline when
 * this returns true AND no slip-batch session already claimed the image.
 *
 * KNOWN LIMITATION (not addressed in this patch): a staff member who sends a
 * settlement-sheet photo WITHOUT first opening the guided journey (no active
 * round, or a round stuck earlier than "slips") gets silently ignored — see
 * webhook-settlement-sheet-image.test.ts's "does not hijack" cases. Widening
 * this gate to also read arbitrary out-of-flow photos is NOT done here; it
 * would let a stray photo of anything get pushed through OCR to a random
 * group.
 *
 * PROPOSED (separate, future patch): a lightweight classifier/router step
 * ahead of this gate — run isLikelySettlementSheet's document_type
 * classification (extraction-schema.ts) BEFORE checking guided-round stage,
 * and only when document_type = SETTLEMENT_SHEET with high confidence, offer
 * the sender a one-tap "open settlement flow for this photo?" prompt rather
 * than silently processing it. This keeps the write path unchanged (still
 * gated on an actual guided round existing) while covering the "staff didn't
 * open the flow" case without any silent auto-hijack of ordinary photos.
 */
export function isAwaitingSettlementSubmission(
  state: GuidedJourneyState,
): state is Exclude<GuidedJourneyState, { stage: "idle" }> & { stage: "slips" | "reconcile" } {
  return state.stage === "slips" || state.stage === "reconcile";
}
