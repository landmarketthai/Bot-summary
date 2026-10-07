import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { parseWhiteSheetPreview, type WhiteSheetPreview } from "./schema";

// Transient review state for the read-only White Sheet flow. This module is the ONLY
// place that touches white_sheet_review_turns, and that table is not an official source:
// no report, loader, settlement or API may read it. Session state never comes from here
// (it is derived from the webhook history), so expired or stray rows can never revive a
// session.
const TABLE = "white_sheet_review_turns";
const MAX_APPLIED_ROWS = 200;

export type TurnOutcome = "applied" | "failed" | "unavailable";
/** base = first read; turn = one correction; approval = one "ผ่าน" (applied = accepted, failed = refused). */
export type TurnKind = "base" | "turn" | "approval";
export type ReviewScope = { destination: string; sourceId: string; userId: string; sheetImageRawId: string };
export type StoredTurn = {
  rawMessageId: string;
  kind: TurnKind;
  outcome: TurnOutcome;
  /** Present only for a valid applied row: strictly re-validated, never trusted as stored. */
  snapshot: WhiteSheetPreview | null;
  /** An applied row whose snapshot no longer validates. */
  corrupt: boolean;
};
export type AppliedSnapshot = { rawMessageId: string; snapshot: WhiteSheetPreview };

type TurnRow = {
  raw_message_id: string; turn_seq: number; kind: TurnKind; outcome: TurnOutcome; snapshot: Json | null;
};
const COLUMNS = "raw_message_id,turn_seq,kind,outcome,snapshot";

function validSnapshot(value: Json | null): WhiteSheetPreview | null {
  if (value === null) return null;
  try { return parseWhiteSheetPreview(value); } catch { return null; }
}

function scoped(db: SupabaseClient<Database>, scope: ReviewScope) {
  return db.from(TABLE).select(COLUMNS).eq("destination", scope.destination).eq("source_id", scope.sourceId)
    .eq("user_id", scope.userId).eq("sheet_image_raw_id", scope.sheetImageRawId);
}

/** The recorded outcome of one event, if it was ever evaluated. Throws on a read failure. */
export async function loadTurn(
  db: SupabaseClient<Database>, scope: ReviewScope, rawMessageId: string,
): Promise<StoredTurn | null> {
  const { data, error } = await scoped(db, scope).eq("raw_message_id", rawMessageId).maybeSingle();
  if (error) throw new Error("Review turn unavailable");
  if (!data) return null;
  const row = data as unknown as TurnRow;
  const snapshot = row.outcome === "applied" ? validSnapshot(row.snapshot) : null;
  return {
    rawMessageId: row.raw_message_id, kind: row.kind, outcome: row.outcome, snapshot,
    corrupt: row.outcome === "applied" && snapshot === null,
  };
}

/**
 * The newest applied snapshot of the sheet (highest insertion sequence). Null when there is
 * none or when the newest one fails strict validation: the caller must fail closed.
 */
export async function loadLatestApplied(
  db: SupabaseClient<Database>, scope: ReviewScope,
): Promise<AppliedSnapshot | null> {
  const { data, error } = await scoped(db, scope).eq("outcome", "applied").in("kind", ["base", "turn"])
    .order("turn_seq", { ascending: false }).limit(MAX_APPLIED_ROWS);
  if (error || !data) throw new Error("Review turn unavailable");
  const rows = data as unknown as TurnRow[];
  const latest = rows.reduce<TurnRow | null>((best, row) => (!best || row.turn_seq > best.turn_seq ? row : best), null);
  const snapshot = latest ? validSnapshot(latest.snapshot) : null;
  return latest && snapshot ? { rawMessageId: latest.raw_message_id, snapshot } : null;
}

/**
 * Append one outcome. "duplicate" = this event was already recorded (idempotent redelivery);
 * "conflict" = another applied transition (correction or approval) already consumed the same parent.
 */
export async function recordTurn(
  db: SupabaseClient<Database>, scope: ReviewScope,
  turn: { rawMessageId: string; kind: TurnKind; outcome: TurnOutcome;
    snapshot?: WhiteSheetPreview; parentRawMessageId?: string },
): Promise<"recorded" | "duplicate" | "conflict"> {
  const { error } = await db.from(TABLE).insert({
    raw_message_id: turn.rawMessageId, destination: scope.destination, source_id: scope.sourceId,
    user_id: scope.userId, sheet_image_raw_id: scope.sheetImageRawId,
    parent_raw_message_id: turn.parentRawMessageId ?? null, kind: turn.kind, outcome: turn.outcome,
    snapshot: (turn.snapshot ?? null) as unknown as Json,
  });
  if (!error) return "recorded";
  if (error.code !== "23505") throw new Error("Review turn not recorded");
  return (await loadTurn(db, scope, turn.rawMessageId)) ? "duplicate" : "conflict";
}

/**
 * For history replay: which of these approval events were ACCEPTED, and for which sheet.
 * A refused or unrecorded approval is absent, so it can never advance the session state.
 */
export async function loadAcceptedApprovals(
  db: SupabaseClient<Database>, scope: Omit<ReviewScope, "sheetImageRawId">, approvalRawIds: string[],
): Promise<Map<string, string>> {
  if (!approvalRawIds.length) return new Map();
  const { data, error } = await db.from(TABLE).select("raw_message_id,sheet_image_raw_id")
    .eq("destination", scope.destination).eq("source_id", scope.sourceId).eq("user_id", scope.userId)
    .eq("kind", "approval").eq("outcome", "applied").in("raw_message_id", approvalRawIds);
  if (error || !data) throw new Error("Review turn unavailable");
  return new Map(data.map((row) => [row.raw_message_id, row.sheet_image_raw_id]));
}

/** Best-effort retention: drop this source's rows past the session cap. Never required for correctness. */
export async function pruneExpiredTurns(
  db: SupabaseClient<Database>, sourceId: string, maxAgeMs: number, now = Date.now(),
): Promise<void> {
  try {
    await db.from(TABLE).delete().eq("source_id", sourceId)
      .lt("created_at", new Date(now - maxAgeMs).toISOString());
  } catch { /* retention only */ }
}
