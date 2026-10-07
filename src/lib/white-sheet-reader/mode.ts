import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { LineMessageEvent, LineTextMessage } from "@/lib/line/types";
import { extractBotSummaryQuestion } from "@/lib/ai/line-command";
import { getSourceId, getUserId } from "@/lib/line/verify";

export const PREVIEW_TTL_MS = 10 * 60_000;
export function isWhiteSheetReaderEnabled(
  value = process.env.BOT_SUMMARY_WHITE_SHEET_READER_ENABLED,
): boolean {
  return value === "true";
}
export type WhiteSheetReadMode = "none" | "read" | "consumed";
export function whiteSheetReadCommand(message: LineTextMessage, destination: string): "start" | "cancel" | null {
  const question = extractBotSummaryQuestion(message, destination);
  return question === "อ่านใบขาว" ? "start" : question === "ยกเลิกอ่านใบขาว" ? "cancel" : null;
}

export async function resolveWhiteSheetReadMode(
  db: SupabaseClient<Database>, event: LineMessageEvent, rawMessageId: string,
  destination: string, now = Date.now(),
): Promise<WhiteSheetReadMode> {
  const userId = getUserId(event.source);
  if (event.source.type !== "group" || !userId || event.message.type !== "image") return "none";
  if (!Number.isFinite(event.timestamp)) throw new Error("Invalid preview event time");
  const sourceId = getSourceId(event.source);
  const { data: current, error: currentError } = await db.from("line_webhook_event_queue")
    .select("receive_order").eq("raw_message_id", rawMessageId).eq("source_id", sourceId).maybeSingle();
  if (currentError || !current) throw new Error("Preview ordering unavailable");
  // ponytail: cap context at 200 queued group events / 10 min; fail closed on
  // overflow. Add paginated history only if actual group traffic needs it.
  const { data: queue, error: queueError } = await db.from("line_webhook_event_queue")
    .select("raw_message_id,receive_order").eq("source_id", sourceId)
    .gte("received_at", new Date(now - PREVIEW_TTL_MS).toISOString())
    .lte("receive_order", current.receive_order).order("receive_order", { ascending: false }).limit(201);
  if (queueError || !queue || queue.length > 200) throw new Error("Preview context unavailable");
  const { data: rows, error } = await db.from("raw_messages")
    .select("id,message_type,payload,is_processed").in("id", queue.map((row) => row.raw_message_id))
    .eq("source_type", event.source.type).eq("source_id", sourceId)
    .eq("user_id", userId).eq("destination", destination);
  if (error || !rows || !rows.some((row) => row.id === rawMessageId)) throw new Error("Preview context unavailable");
  const order = new Map(queue.map((row) => [row.raw_message_id, row.receive_order]));
  const history = rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  let mode: WhiteSheetReadMode = "none";
  for (const row of history) {
    const raw = row.payload as unknown as LineMessageEvent;
    if (row.message_type === "text") {
      // Preview start/cancel commands and images share the existing durable queue.
      if (raw.message?.type !== "text" || extractBotSummaryQuestion(raw.message, destination) === null) continue;
      if (!Number.isFinite(raw.timestamp)) throw new Error("Invalid preview command time");
      const active = whiteSheetReadCommand(raw.message, destination) === "start"
        && now >= raw.timestamp && now - raw.timestamp < PREVIEW_TTL_MS;
      if (active && raw.timestamp > event.timestamp) throw new Error("Image predates preview command");
      if (active && !row.is_processed) throw new Error("Preview command not ready");
      mode = active ? "read" : "none";
    } else if (row.message_type === "image" && row.id !== rawMessageId && mode === "read") {
      mode = "consumed";
    }
  }
  return mode;
}
