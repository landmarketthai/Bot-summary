/**
 * Recovery that does not depend on LINE webhook redelivery.
 *
 * When enqueue fails the webhook leaves the raw message unprocessed and
 * answers 503, asking LINE to redeliver. LINE webhook redelivery is OFF by
 * default, is not guaranteed even when on, and may be force-disabled by LINE.
 * This sweep (run by the assistant worker cron) enqueues recent @Botsummary
 * questions whose raw message is still unprocessed, exactly as the webhook
 * would have, so a failed enqueue is recovered either way. Enqueue is
 * idempotent by webhookEventId, so racing a redelivery or the ordered queue
 * is harmless.
 *
 * Skipped (left untouched): non-questions, white-sheet session commands,
 * texts that could be white-sheet review input while the reader is enabled,
 * chats not on the source allowlist, and anything younger than `minAgeMs`
 * (its webhook may still be in flight).
 *
 * The scan pages through the window (keyset on created_at, `limit` rows per
 * page, at most `maxRows` rows) so unprocessed non-question messages left by
 * other workflows cannot hide a question behind the first page.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import { extractBotSummaryQuestion } from "@/lib/ai/line-command";
import type { LineMessageEvent, LineTextMessage } from "@/lib/line/types";
import { whiteSheetReadCommand, whiteSheetReviewInput } from "@/lib/white-sheet-reader/mode";
import type { AssistantDispatcher } from "./dispatch";

type Supabase = SupabaseClient<Database>;

export interface RecoverySummary {
  scanned: number;
  enqueued: number;
  duplicate: number;
  /** Left unprocessed for the next sweep (rate limited, queue full, enqueue error). */
  deferred: number;
  skipped: number;
}

export async function recoverUnenqueuedQuestions(options: {
  supabase: Supabase;
  dispatcher: AssistantDispatcher;
  analystEnabled: boolean;
  sourceAllowed: (sourceId: string) => boolean;
  whiteSheetReaderEnabled: boolean;
  windowMinutes?: number;
  minAgeMs?: number;
  /** Rows per page. */
  limit?: number;
  /** Rows examined per sweep, across pages. */
  maxRows?: number;
  now?: number;
}): Promise<RecoverySummary> {
  const summary: RecoverySummary = { scanned: 0, enqueued: 0, duplicate: 0, deferred: 0, skipped: 0 };
  if (!options.analystEnabled) return summary;
  const now = options.now ?? Date.now();
  const since = new Date(now - (options.windowMinutes ?? 30) * 60_000).toISOString();
  const until = new Date(now - (options.minAgeMs ?? 30_000)).toISOString();

  const pageSize = Math.max(1, options.limit ?? 50);
  const maxRows = Math.max(pageSize, options.maxRows ?? 250);
  const seen = new Set<string>();
  let cursor = since;

  while (summary.scanned < maxRows) {
    const { data, error } = await options.supabase
      .from("raw_messages")
      .select("id, destination, source_id, payload, is_processed, created_at")
      .eq("is_processed", false)
      .eq("event_type", "message")
      .eq("message_type", "text")
      .gte("created_at", cursor)
      .lte("created_at", until)
      .order("created_at", { ascending: true })
      .limit(pageSize);
    if (error) throw new Error("ai assistant recovery scan failed");
    const rows = data ?? [];
    // Rows at the cursor timestamp come back again (gte); skip those already seen.
    const fresh = rows.filter((row) => !seen.has(row.id));
    if (fresh.length === 0) break;

    for (const row of fresh) {
      if (summary.scanned >= maxRows) break;
      seen.add(row.id);
      await recoverRow(row);
    }
    if (rows.length < pageSize) break;
    const last = String(rows[rows.length - 1]!.created_at);
    // A full page sharing one timestamp: the next page would repeat it.
    if (last === cursor) break;
    cursor = last;
  }

  async function recoverRow(row: { id: string; destination: string; source_id: string; payload: unknown }) {
    summary.scanned += 1;
    const event = row.payload as unknown as LineMessageEvent | null;
    const message = event?.message as LineTextMessage | undefined;
    if (!event || message?.type !== "text" || typeof message.text !== "string") { summary.skipped += 1; return; }
    const question = extractBotSummaryQuestion(message, row.destination);
    if (!question
      || !options.sourceAllowed(row.source_id)
      || whiteSheetReadCommand(message, row.destination) !== null
      || (options.whiteSheetReaderEnabled && whiteSheetReviewInput(message, row.destination) !== null)) {
      summary.skipped += 1;
      return;
    }

    let outcome: Awaited<ReturnType<AssistantDispatcher>>["outcome"];
    try {
      outcome = (await options.dispatcher({ event, question, destination: row.destination, rawMessageId: row.id })).outcome;
    } catch {
      outcome = "error";
    }
    if (outcome === "rate_limited" || outcome === "queue_full" || outcome === "error") {
      summary.deferred += 1;
      return;
    }
    if (outcome === "queued") summary.enqueued += 1;
    else summary.duplicate += 1;
    const { error: markError } = await options.supabase
      .from("raw_messages")
      .update({ is_processed: true, processed_at: new Date(now).toISOString() })
      .eq("id", row.id)
      .eq("is_processed", false);
    if (markError) logger.warn("ai assistant recovery could not mark a question processed", { code: markError.code });
  }
  if (summary.enqueued > 0 || summary.deferred > 0) logger.info("ai assistant recovered unenqueued questions", { ...summary });
  return summary;
}
