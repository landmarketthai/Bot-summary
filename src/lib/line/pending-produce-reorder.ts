import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";
import { PendingSessionService } from "@/lib/line/pending-session-service";
import { boundaryRejectReply, type RecoveryReason } from "@/lib/line/pending-produce-recovery";

export const NEW_HEADER_REQUIRED_REPLY =
  "ไม่พบรายการที่เปิดอยู่ กรุณาพิมพ์หัวรายการใหม่ก่อนส่งรายการ";

export interface DeferredProduceSweepResult {
  claimed: number;
  replied: number;
  replyErrors: number;
}

type Push = (to: string, text: string) => Promise<unknown>;

function expiredRejectReason(status: string): RecoveryReason {
  if (status === "rejected_after_close") return "after_close";
  if (status === "rejected_orphan") return "orphan";
  return "before_opener";
}

/**
 * Resolve the bounded reorder window before the close finalizer runs.
 * Rejected rows remain unprocessed and durable for Daily Close evidence.
 */
export async function processExpiredPendingProduceEvents(
  supabase: SupabaseClient<Database>,
  push: Push = pushLineMessage,
  limit = 25,
): Promise<DeferredProduceSweepResult> {
  const events = await new PendingSessionService(supabase)
    .claimExpiredDeferredProduceEvents(limit);
  const result: DeferredProduceSweepResult = {
    claimed: events.length,
    replied: 0,
    replyErrors: 0,
  };
  const countByKey = new Map<string, number>();
  for (const event of events) {
    countByKey.set(event.session_key, (countByKey.get(event.session_key) ?? 0) + 1);
  }

  const pushedKeys = new Set<string>();
  for (const event of events) {
    logger.warn("deferred Produce item rejected after reorder window", {
      action: event.status,
      reason: event.defer_reason,
      sourceId: event.source_id,
      lineUserId: event.line_user_id,
      lineEventId: event.line_event_id,
      lineTimestampMs: event.line_timestamp_ms,
      sessionKey: event.session_key,
      sessionGeneration: event.session_generation,
      openerEventId: event.opener_line_event_id,
      openerTimestampMs: event.opener_line_timestamp_ms,
      closeEventId: event.close_line_event_id,
      closeTimestampMs: event.close_line_timestamp_ms,
      ageMs: Date.parse(event.resolved_at) - Date.parse(event.received_at),
      rawText: event.raw_text,
    });
    // One push per session key per sweep: a claimed burst is one episode, so
    // announcing each message again (with a growing count) is noise, not news.
    if (pushedKeys.has(event.session_key)) continue;
    pushedKeys.add(event.session_key);
    try {
      await push(
        event.source_id,
        boundaryRejectReply(
          countByKey.get(event.session_key) ?? 1,
          expiredRejectReason(event.status),
        ),
      );
      result.replied += 1;
    } catch (error) {
      result.replyErrors += 1;
      logger.error("deferred Produce rejection push failed", {
        lineEventId: event.line_event_id,
        sessionKey: event.session_key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
