import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { LineImageMessage, LineMessageEvent, LineTextMessage } from "@/lib/line/types";
import { extractBotSummaryQuestion } from "@/lib/ai/line-command";
import { getSourceId, getUserId } from "@/lib/line/verify";
import { loadAcceptedApprovals } from "./review-turns";

// A white-sheet session is DERIVED from the durable ordered webhook history
// (raw_messages + line_webhook_event_queue) on every request; nothing about it
// lives in process memory. Scope: destination + group + LINE user. The session
// stays open while the user keeps acting inside it: every event must arrive within
// PREVIEW_TTL_MS of the previous one (sliding window), and the whole session is
// capped at SESSION_MAX_AGE_MS from its start command.
export const PREVIEW_TTL_MS = 10 * 60_000;
export const SESSION_MAX_AGE_MS = 3 * 60 * 60_000;
export const APPROVAL_TEXT = "ผ่าน";
// ponytail: cap replay at 300 of the user's own text/image rows received inside the 3-hour
// session window; fail closed on overflow. Add paging only if a session really needs it.
const MAX_SESSION_ROWS = 300;
const MAX_START_CANDIDATES = 50;

export function isWhiteSheetReaderEnabled(
  value = process.env.BOT_SUMMARY_WHITE_SHEET_READER_ENABLED,
): boolean {
  return value === "true";
}

export type WhiteSheetCommand = "start" | "cancel" | "end";
export function whiteSheetReadCommand(message: LineTextMessage, destination: string): WhiteSheetCommand | null {
  const question = extractBotSummaryQuestion(message, destination);
  return question === "อ่านใบขาว" ? "start" : question === "ยกเลิกอ่านใบขาว" ? "cancel"
    : question === "จบใบขาว" ? "end" : null;
}
export function isWhiteSheetApproval(text: string): boolean {
  return text.trim() === APPROVAL_TEXT;
}
/** Only a single LINE-hosted image can be read; anything else never advances the session. */
export function isReadableWhiteSheetImage(message: LineImageMessage): boolean {
  return message.contentProvider.type === "line" && (!message.imageSet || message.imageSet.total === 1);
}

/**
 * The processing order of stateful LINE events: exactly the order claim_line_webhook_event
 * uses (migration 20260930090000):
 *   (CASE WHEN payload->>'timestamp' ~ '^[0-9]+$' THEN that bigint
 *         ELSE floor(epoch(received_at) * 1000) END,  receive_order)
 * Session replay MUST use this and nothing else, or it can disagree with the order in
 * which the worker actually processed the events.
 */
export type SemanticKey = { ms: number; order: number };
export function semanticKey(payloadTimestamp: unknown, receivedAt: string | null | undefined, receiveOrder: number): SemanticKey {
  const numeric = typeof payloadTimestamp === "number" ? Number.isSafeInteger(payloadTimestamp) && payloadTimestamp >= 0
    : typeof payloadTimestamp === "string" && /^[0-9]+$/u.test(payloadTimestamp);
  const ms = numeric ? Number(payloadTimestamp) : Math.floor(Date.parse(receivedAt ?? ""));
  if (!Number.isFinite(ms) || !Number.isFinite(receiveOrder)) throw new Error("Invalid session event order");
  return { ms, order: receiveOrder };
}
export function compareSemantic(a: SemanticKey, b: SemanticKey): number {
  return a.ms - b.ms || a.order - b.order;
}

export type WhiteSheetSessionState = "none" | "awaiting_image" | "reviewing" | "approved_waiting_next_image";
/** The sheet under review is identified by its image event; its data lives in the transient review-turns store. */
export type WhiteSheetSheet = { imageRawId: string };
export type WhiteSheetSession = { state: WhiteSheetSessionState; sheet: WhiteSheetSheet | null };
export const NO_WHITE_SHEET_SESSION: WhiteSheetSession = { state: "none", sheet: null };

export type ReplayEvent = {
  rawId: string;
  /** Semantic (claim-order) timestamp in ms. */
  timestamp: number;
  kind: WhiteSheetCommand | "approval" | "text" | "image";
  /** approval only: the sheet this approval was ACCEPTED for (null = refused or never recorded). */
  acceptedSheet?: string | null;
};

/**
 * Pure state machine over one user's events, already in claim order, strictly BEFORE the
 * event being processed. Returns the state that event sees.
 *
 *   start    -> awaiting_image  (also restarts a sheet that is under review)
 *   image    -> reviewing       (only from awaiting_image / approved_waiting)
 *   text     -> keeps a review alive (the correction itself is evaluated once, in the review-turns store)
 *   approval -> approved_waiting_next_image, only while reviewing AND only if it was accepted
 *               for this very sheet; a refused approval changes nothing
 *   cancel   -> none;  end -> none, unless a sheet is still under review
 * A session also ends PREVIEW_TTL_MS after its last action, and SESSION_MAX_AGE_MS after its
 * start command (hard cap), both measured on the same claim-order timestamps.
 */
export function replayWhiteSheetSession(
  events: ReplayEvent[], currentTimestamp: number, now: number,
): WhiteSheetSession {
  let state: WhiteSheetSessionState = "none";
  let sheet: WhiteSheetSheet | null = null;
  let lastActivity = Number.NEGATIVE_INFINITY;
  let startedAt = Number.NEGATIVE_INFINITY;
  const expired = (at: number) => at - lastActivity >= PREVIEW_TTL_MS || at - startedAt >= SESSION_MAX_AGE_MS;
  for (const event of events) {
    if (!Number.isFinite(event.timestamp)) throw new Error("Invalid session event time");
    if (state !== "none" && expired(event.timestamp)) { state = "none"; sheet = null; }
    const live = state !== "none";
    if (event.kind === "start") { state = "awaiting_image"; sheet = null; startedAt = event.timestamp; }
    else if (event.kind === "cancel") { state = "none"; sheet = null; }
    else if (event.kind === "end") { if (state !== "reviewing") { state = "none"; sheet = null; } }
    else if (event.kind === "image") {
      if (state === "awaiting_image" || state === "approved_waiting_next_image") {
        state = "reviewing";
        sheet = { imageRawId: event.rawId };
      }
    } else if (state === "reviewing" && event.kind === "approval"
      && event.acceptedSheet != null && event.acceptedSheet === sheet?.imageRawId) {
      state = "approved_waiting_next_image"; sheet = null;
    }
    if (live || event.kind === "start") lastActivity = event.timestamp;
  }
  if (state !== "none" && (expired(now) || expired(currentTimestamp))) return NO_WHITE_SHEET_SESSION;
  return { state, sheet };
}

type SessionRow = {
  id: string; message_type: string | null; payload: unknown; is_processed: boolean; created_at?: string;
};

function replayKindFromRow(row: SessionRow, destination: string): ReplayEvent["kind"] | null {
  const raw = row.payload as LineMessageEvent | null;
  if (!raw?.message) return null;
  if (row.message_type === "image" && raw.message.type === "image") {
    return isReadableWhiteSheetImage(raw.message) ? "image" : null;
  }
  if (row.message_type === "text" && raw.message.type === "text") {
    const command = whiteSheetReadCommand(raw.message, destination);
    if (command) return command;
    // Other @Botsummary messages (analyst Q&A) are never corrections.
    if (extractBotSummaryQuestion(raw.message, destination) !== null) return null;
    return isWhiteSheetApproval(raw.message.text) ? "approval" : "text";
  }
  return null;
}
const payloadTimestamp = (payload: unknown) => (payload as { timestamp?: unknown } | null)?.timestamp;

/** Cheap superset test used when a group text is received: may this user own a session? */
export async function whiteSheetSessionMayBeActive(
  db: SupabaseClient<Database>, event: LineMessageEvent, destination: string, now = Date.now(),
): Promise<boolean> {
  const userId = getUserId(event.source);
  if (event.source.type !== "group" || !userId) return false;
  const { data, error } = await db.from("raw_messages").select("id,message_type,payload,is_processed")
    .eq("destination", destination).eq("source_type", "group").eq("source_id", getSourceId(event.source))
    .eq("user_id", userId).eq("message_type", "text").ilike("raw_text", "%อ่านใบขาว%")
    .gte("created_at", new Date(now - SESSION_MAX_AGE_MS).toISOString()).limit(MAX_START_CANDIDATES);
  // Unknown is treated as "maybe": the event is queued and the resolver decides.
  if (error || !data) return true;
  return data.some((row) => replayKindFromRow(row, destination) === "start");
}

export async function resolveWhiteSheetSession(
  db: SupabaseClient<Database>, event: LineMessageEvent, rawMessageId: string,
  destination: string, now = Date.now(),
): Promise<WhiteSheetSession> {
  const userId = getUserId(event.source);
  if (event.source.type !== "group" || !userId) return NO_WHITE_SHEET_SESSION;
  const sourceId = getSourceId(event.source);
  const { data: current, error: currentError } = await db.from("line_webhook_event_queue")
    .select("receive_order,received_at").eq("raw_message_id", rawMessageId).eq("source_id", sourceId).maybeSingle();
  if (currentError || !current) {
    // An image is always queued, so a missing row is an outage. A text that was never queued
    // was received while no session could be open; a lookup outage must not swallow ordinary
    // group chat, and the legacy path it falls to needs the same store anyway.
    if (event.message.type === "image") throw new Error("Session ordering unavailable");
    return NO_WHITE_SHEET_SESSION;
  }
  const mine = () => db.from("raw_messages").select("id,message_type,payload,is_processed,created_at")
    .eq("destination", destination).eq("source_type", "group").eq("source_id", sourceId).eq("user_id", userId);
  const { data: self, error: selfError } = await mine().eq("id", rawMessageId).maybeSingle();
  if (selfError || !self) throw new Error("Session context unavailable");
  const currentKey = semanticKey(payloadTimestamp(self.payload), current.received_at, current.receive_order);

  const queued = async (rows: SessionRow[]): Promise<Map<string, SemanticKey>> => {
    if (!rows.length) return new Map();
    const { data, error } = await db.from("line_webhook_event_queue").select("raw_message_id,receive_order,received_at")
      .eq("source_id", sourceId).in("raw_message_id", rows.map((row) => row.id));
    if (error || !data) throw new Error("Session ordering unavailable");
    const byId = new Map(rows.map((row) => [row.id, row]));
    return new Map(data.map((entry) => [entry.raw_message_id,
      semanticKey(payloadTimestamp(byId.get(entry.raw_message_id)?.payload), entry.received_at, entry.receive_order)]));
  };

  // 1. The latest start command that precedes this event in claim order.
  const { data: candidates, error: candidateError } = await mine().eq("message_type", "text")
    .ilike("raw_text", "%อ่านใบขาว%").gte("created_at", new Date(now - SESSION_MAX_AGE_MS).toISOString())
    .order("created_at", { ascending: false }).limit(MAX_START_CANDIDATES);
  if (candidateError || !candidates) throw new Error("Session context unavailable");
  const candidateKeys = await queued(candidates);
  const start = candidates
    .filter((row) => replayKindFromRow(row, destination) === "start" && candidateKeys.has(row.id)
      && compareSemantic(candidateKeys.get(row.id)!, currentKey) < 0)
    .sort((a, b) => compareSemantic(candidateKeys.get(b.id)!, candidateKeys.get(a.id)!))[0];
  if (!start) return NO_WHITE_SHEET_SESSION;
  const startKey = candidateKeys.get(start.id)!;

  // 2. Everything this user said from the start onward, in claim order. Retrieval is bounded
  // only by the 3-hour session window; participation and order come from the claim-order key
  // alone, so a webhook delivered long after its LINE timestamp (or a skewed clock) is still
  // placed exactly where the queue worker placed it.
  const { data: rows, error } = await mine().in("message_type", ["text", "image"])
    .gte("created_at", new Date(now - SESSION_MAX_AGE_MS).toISOString())
    .order("created_at", { ascending: true }).limit(MAX_SESSION_ROWS + 1);
  if (error || !rows || rows.length > MAX_SESSION_ROWS) throw new Error("Session context unavailable");
  const keys = await queued(rows);
  const history = rows
    .filter((row) => keys.has(row.id) && compareSemantic(keys.get(row.id)!, startKey) >= 0
      && compareSemantic(keys.get(row.id)!, currentKey) < 0)
    .sort((a, b) => compareSemantic(keys.get(a.id)!, keys.get(b.id)!));
  const events: ReplayEvent[] = [];
  for (const row of history) {
    const kind = replayKindFromRow(row, destination);
    if (!kind) continue;
    if (["start", "cancel", "end"].includes(kind) && !row.is_processed) throw new Error("Session command not ready");
    events.push({ rawId: row.id, kind, timestamp: keys.get(row.id)!.ms });
  }
  // 3. Which approvals were ACCEPTED (a refused one never advances the session).
  const accepted = await loadAcceptedApprovals(db, { destination, sourceId, userId },
    events.filter((replay) => replay.kind === "approval").map((replay) => replay.rawId));
  for (const replay of events) if (replay.kind === "approval") replay.acceptedSheet = accepted.get(replay.rawId) ?? null;
  return replayWhiteSheetSession(events, currentKey.ms, now);
}
