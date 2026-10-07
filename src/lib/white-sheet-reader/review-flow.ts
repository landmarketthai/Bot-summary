import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  applyWhiteSheetCorrection, readWhiteSheetBase, renderWhiteSheetPreview,
  APPROVAL_RETRY_REPLY, CORRECTION_CAPTURE_FAILED_REPLY, CORRECTION_RETRY_REPLY, MISSING_REVIEW_BASE_REPLY,
  PREVIEW_APPROVED_REPLY, PREVIEW_RETRY_REPLY, PREVIEW_UNKNOWN_REPLY,
} from "./reader";
import { SESSION_MAX_AGE_MS } from "./mode";
import {
  loadLatestApplied, loadTurn, pruneExpiredTurns, recordTurn, type ReviewScope, type StoredTurn,
} from "./review-turns";

// Orchestration of one sheet's review. Every model call is made at most once per LINE event:
// the outcome is recorded under the event's raw_message_id, and a repeat of the same event
// (queue retry, lease reclaim, redelivery) replays the recorded outcome and calls nothing.
export type ReviewFlowDependencies = {
  readBase?: typeof readWhiteSheetBase;
  applyCorrection?: typeof applyWhiteSheetCorrection;
};
export type ReviewEventScope = Omit<ReviewScope, "sheetImageRawId">;

function replayBase(turn: StoredTurn): string[] {
  if (turn.corrupt) return [MISSING_REVIEW_BASE_REPLY];
  if (turn.outcome === "applied" && turn.snapshot) return renderWhiteSheetPreview(turn.snapshot, "review");
  return [turn.outcome === "failed" ? PREVIEW_UNKNOWN_REPLY : PREVIEW_RETRY_REPLY];
}

function replayApproval(turn: StoredTurn): string[] {
  if (turn.outcome === "applied") return [PREVIEW_APPROVED_REPLY];
  return [turn.outcome === "unavailable" ? APPROVAL_RETRY_REPLY : MISSING_REVIEW_BASE_REPLY];
}

function replayTurn(turn: StoredTurn): string[] {
  if (turn.corrupt) return [MISSING_REVIEW_BASE_REPLY];
  if (turn.outcome === "applied" && turn.snapshot) return renderWhiteSheetPreview(turn.snapshot, "corrected");
  return [turn.outcome === "failed" ? CORRECTION_CAPTURE_FAILED_REPLY : CORRECTION_RETRY_REPLY];
}

/** First image of a sheet: one Vision read, recorded as the base every correction starts from. */
export async function readAndRecordSheet(
  db: SupabaseClient<Database>, scope: ReviewEventScope, imageRawId: string, imageMessageId: string,
  deps: ReviewFlowDependencies = {},
): Promise<string[]> {
  const sheet: ReviewScope = { ...scope, sheetImageRawId: imageRawId };
  const recorded = await loadTurn(db, sheet, imageRawId);
  if (recorded) return replayBase(recorded);
  const read = await (deps.readBase ?? readWhiteSheetBase)(imageMessageId);
  // A fresh read may be shown only if that exact base is now stored, or an already-stored base
  // for this very event was loaded and is what gets rendered. Anything else fails closed.
  const status = await recordTurn(db, sheet, {
    rawMessageId: imageRawId, kind: "base", outcome: read.outcome,
    snapshot: read.outcome === "applied" ? read.snapshot : undefined,
  });
  if (status === "recorded") {
    await pruneExpiredTurns(db, scope.sourceId, SESSION_MAX_AGE_MS);
    return read.replies;
  }
  if (status === "duplicate") {
    const winner = await loadTurn(db, sheet, imageRawId);
    if (winner) return replayBase(winner);
  }
  return [MISSING_REVIEW_BASE_REPLY];
}

/**
 * "ผ่าน" while a sheet is under review. Accepted ONLY when the sheet has a valid persisted applied
 * snapshot; the decision (accepted or refused) is recorded under the approval's raw_message_id,
 * which is what session replay reads, so a refused approval can never advance the session.
 */
export async function reviewApproval(
  db: SupabaseClient<Database>, scope: ReviewEventScope, imageRawId: string, approvalRawId: string,
): Promise<string[]> {
  const sheet: ReviewScope = { ...scope, sheetImageRawId: imageRawId };
  const recorded = await loadTurn(db, sheet, approvalRawId);
  if (recorded) return replayApproval(recorded);
  const latest = await loadLatestApplied(db, sheet);
  const status = latest
    ? await recordTurn(db, sheet, { rawMessageId: approvalRawId, kind: "approval", outcome: "applied",
      snapshot: latest.snapshot, parentRawMessageId: latest.rawMessageId })
    : await recordTurn(db, sheet, { rawMessageId: approvalRawId, kind: "approval", outcome: "failed" });
  if (status === "duplicate") {
    const winner = await loadTurn(db, sheet, approvalRawId);
    return winner ? replayApproval(winner) : [MISSING_REVIEW_BASE_REPLY];
  }
  if (status === "conflict") {
    // Another applied transition (a correction, or another approval) already consumed this
    // snapshot. Never report a stale approval as accepted: record it as not applied.
    await recordTurn(db, sheet, { rawMessageId: approvalRawId, kind: "approval", outcome: "unavailable" });
    return [APPROVAL_RETRY_REPLY];
  }
  return latest ? [PREVIEW_APPROVED_REPLY] : [MISSING_REVIEW_BASE_REPLY];
}

/**
 * One correction message. Starts from the newest applied snapshot, never from Vision. The
 * outcome is recorded exactly once, so a failed or unavailable message can never apply later.
 */
export async function reviewCorrectionTurn(
  db: SupabaseClient<Database>, scope: ReviewEventScope, imageRawId: string, turnRawId: string, text: string,
  deps: ReviewFlowDependencies = {},
): Promise<string[]> {
  const sheet: ReviewScope = { ...scope, sheetImageRawId: imageRawId };
  const recorded = await loadTurn(db, sheet, turnRawId);
  if (recorded) return replayTurn(recorded);
  const parent = await loadLatestApplied(db, sheet);
  if (!parent) return [MISSING_REVIEW_BASE_REPLY];
  const result = await (deps.applyCorrection ?? applyWhiteSheetCorrection)(parent.snapshot, text);
  const status = await recordTurn(db, sheet, {
    rawMessageId: turnRawId, kind: "turn", outcome: result.outcome, parentRawMessageId: parent.rawMessageId,
    snapshot: result.outcome === "applied" ? result.snapshot : undefined,
  });
  if (status === "duplicate") {
    const winner = await loadTurn(db, sheet, turnRawId);
    return winner ? replayTurn(winner) : [CORRECTION_RETRY_REPLY];
  }
  if (status === "conflict") {
    // Another applied transition (a correction or an accepted approval) already consumed this
    // parent: never branch. Record this one as not applied; the user retries if still reviewing.
    await recordTurn(db, sheet, { rawMessageId: turnRawId, kind: "turn", outcome: "unavailable" });
    return [CORRECTION_RETRY_REPLY];
  }
  return result.replies;
}
