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
 * Scanning (SQL: list_ai_assistant_recovery_candidates, migration
 * 20261031170000):
 * - only rows that can be a question are read (text contains '@' or the
 *   message mentions the bot); other workflows' unprocessed rows are never
 *   fetched, so they cannot crowd a question out;
 * - pages are a composite keyset on (created_at, id): rows that share a
 *   timestamp are each visited exactly once and the loop cannot repeat;
 * - each sweep examines at most `maxRows` rows in pages of `limit`, resuming
 *   after the key where the previous sweep stopped (a persisted cursor). On
 *   reaching the end of the window the cursor is cleared, so the next sweep
 *   starts at the window start again and deferred rows are retried. Every
 *   candidate is visited within ceil(candidates in window / maxRows) sweeps.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import { extractBotSummaryQuestion } from "@/lib/ai/line-command";
import type { LineMessageEvent, LineTextMessage } from "@/lib/line/types";
import { whiteSheetReadCommand, whiteSheetReviewInput } from "@/lib/white-sheet-reader/mode";
import type { AssistantDispatcher } from "./dispatch";

type Supabase = SupabaseClient<Database>;

interface RecoveryCandidate {
  id: string;
  destination: string;
  source_id: string;
  payload: unknown;
  created_at: string;
}

interface RecoveryKey {
  createdAt: string;
  id: string;
}

/** The key the previous sweep stopped at; null = start at the window start. */
async function readCursor(supabase: Supabase): Promise<RecoveryKey | null> {
  const { data, error } = await supabase.rpc("get_ai_assistant_recovery_cursor", {});
  if (error) {
    logger.warn("ai assistant recovery could not read its cursor", { code: error.code });
    return null;
  }
  const value = data as { after_created_at?: unknown; after_id?: unknown } | null;
  return typeof value?.after_created_at === "string" && typeof value.after_id === "string"
    ? { createdAt: value.after_created_at, id: value.after_id }
    : null;
}

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

  const pageSize = Math.min(200, Math.max(1, options.limit ?? 50));
  const maxRows = Math.max(1, options.maxRows ?? 250);

  // Keys stay exactly as PostgreSQL returned them (microseconds): a value
  // rounded through Date would repeat or skip rows at the boundary.
  let after = await readCursor(options.supabase);
  let reachedEnd = false;
  while (summary.scanned < maxRows) {
    const want = Math.min(pageSize, maxRows - summary.scanned);
    const { data, error } = await options.supabase.rpc("list_ai_assistant_recovery_candidates", {
      p_since: since,
      p_until: until,
      p_after_created_at: after?.createdAt ?? null,
      p_after_id: after?.id ?? null,
      p_limit: want,
    });
    if (error) throw new Error("ai assistant recovery scan failed");
    const rows = (data ?? []) as RecoveryCandidate[];
    for (const row of rows) {
      await recoverRow(row);
      after = { createdAt: String(row.created_at), id: row.id };
    }
    if (rows.length < want) {
      reachedEnd = true;
      break;
    }
  }
  // End of the window: start from its beginning next time. Otherwise resume here.
  const { error: cursorError } = await options.supabase.rpc("set_ai_assistant_recovery_cursor", {
    p_after_created_at: reachedEnd ? null : after?.createdAt ?? null,
    p_after_id: reachedEnd ? null : after?.id ?? null,
  });
  if (cursorError) logger.warn("ai assistant recovery could not store its cursor", { code: cursorError.code });

  async function recoverRow(row: RecoveryCandidate) {
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
