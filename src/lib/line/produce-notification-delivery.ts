import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { LinePushError, pushLineMessages } from "@/lib/line/reply";
import {
  LINE_MESSAGE_MAX_CODE_POINTS,
  LINE_REPLY_MAX_MESSAGES,
  chunkBlocks,
} from "@/lib/summary/line-chunking";
import { getRuntimeEnvironment } from "@/lib/runtime-environment";

const MAX_CYCLE_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5_000;
const MAX_EXPONENTIAL_BACKOFF_MS = 5 * 60_000;

// The hand-maintained Database type intentionally lags RPC-only operational
// tables, so this worker uses the generic client at that narrow boundary.
type AnyClient = SupabaseClient<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type NotificationPush = (
  to: string,
  text: string,
  retryKey: string,
) => Promise<unknown>;

export interface ProduceNotificationRecord {
  id: string;
  produce_session_id: string;
  session_key: string;
  session_generation: string;
  source_id: string;
  correlation_id: string;
  notification_status: "pending" | "sending" | "sent" | "failed";
  notification_attempt_count: number;
  notification_cycle_attempt_count: number;
  notification_retryable: boolean;
  last_notification_error: string | null;
  last_notification_attempt_at: string | null;
  notification_sent_at: string | null;
  notification_payload: string;
  line_retry_key: string;
  next_notification_attempt_at: string | null;
  sending_started_at: string | null;
  resend_count: number;
  last_resend_requested_at: string | null;
  created_at: string;
  updated_at: string;
  /** 0061: environment ownership — see src/lib/runtime-environment.ts. */
  runtime_environment?: "production" | "preview" | "development" | null;
}

export type NotificationAttemptResult =
  | "sent"
  | "retry_scheduled"
  | "failed"
  | "stale_completion";

export interface ProduceNotificationRun {
  claimed: number;
  sent: number;
  retryScheduled: number;
  failed: number;
  staleCompletions: number;
  errors: number;
}

interface ClassifiedPushError {
  message: string;
  retryable: boolean;
  httpStatus: number | null;
  retryAfterMs: number | null;
}

function chunkProduceNotificationPayload(text: string): string[] {
  return chunkBlocks(text.split("\n\n"), LINE_MESSAGE_MAX_CODE_POINTS);
}

/** Whether `text` can be delivered as one push of at most five LINE messages. */
export function fitsProduceNotification(text: string): boolean {
  return chunkProduceNotificationPayload(text).length <= LINE_REPLY_MAX_MESSAGES;
}

/**
 * One stored notification → up to five LINE text messages in ONE push request,
 * so a single retry key covers the whole delivery. Too long to fit is a
 * permanent (non-retryable) failure; payload builders size themselves with
 * fitsProduceNotification so this is not reached in practice.
 */
export function splitProduceNotificationPayload(text: string): string[] {
  const chunks = chunkProduceNotificationPayload(text);
  if (chunks.length > LINE_REPLY_MAX_MESSAGES) {
    throw new LinePushError(
      `produce notification needs ${chunks.length} LINE messages; max is ${LINE_REPLY_MAX_MESSAGES}`,
      400,
      false,
    );
  }
  return chunks;
}

const defaultPush: NotificationPush = (to, text, retryKey) =>
  pushLineMessages(to, splitProduceNotificationPayload(text), retryKey);

export function notificationRetryDelayMs(
  cycleAttemptCount: number,
  retryAfterMs: number | null,
): number {
  const exponent = Math.max(0, cycleAttemptCount - 1);
  const exponential = Math.min(
    BASE_BACKOFF_MS * (2 ** exponent),
    MAX_EXPONENTIAL_BACKOFF_MS,
  );
  return Math.max(exponential, retryAfterMs ?? 0);
}

function classifyPushError(error: unknown): ClassifiedPushError {
  if (error instanceof LinePushError) {
    return {
      message: error.message,
      retryable: error.retryable,
      httpStatus: error.httpStatus,
      retryAfterMs: error.retryAfterMs,
    };
  }

  return {
    message: error instanceof Error ? error.message : String(error),
    // Unknown thrown errors are treated like transient network failures.
    retryable: true,
    httpStatus: null,
    retryAfterMs: null,
  };
}

async function completeAttempt(
  supabase: AnyClient,
  notification: ProduceNotificationRecord,
  params: {
    status: "sent" | "failed";
    error?: string | null;
    retryable?: boolean;
    nextAttemptAt?: string | null;
    httpStatus?: number | null;
    retryAfterMs?: number | null;
  },
): Promise<boolean> {
  const { data, error } = await supabase.rpc(
    "complete_produce_notification_attempt",
    {
      p_notification_id: notification.id,
      p_attempt_number: notification.notification_attempt_count,
      p_status: params.status,
      p_error: params.error ?? null,
      p_retryable: params.retryable ?? false,
      p_next_attempt_at: params.nextAttemptAt ?? null,
      p_http_status: params.httpStatus ?? null,
      p_retry_after_ms: params.retryAfterMs ?? null,
    },
  );
  if (error) {
    throw new Error(`produce notification completion failed: ${error.message}`);
  }
  return data === true;
}

export async function deliverClaimedProduceNotification(
  supabase: AnyClient,
  notification: ProduceNotificationRecord,
  push: NotificationPush = defaultPush,
  now = new Date(),
): Promise<NotificationAttemptResult> {
  const log = logger.child({
    correlationId: notification.correlation_id,
    produceSessionId: notification.produce_session_id,
    notificationId: notification.id,
    notificationAttempt: notification.notification_attempt_count,
  });

  log.info("produce notification attempt started");

  let pushError: unknown = null;
  try {
    await push(
      notification.source_id,
      notification.notification_payload,
      notification.line_retry_key,
    );
  } catch (error) {
    pushError = error;
  }

  if (pushError === null) {
    // Do not classify a persistence failure as a LINE failure. If this write
    // fails, the stale-sending claim retries with the same LINE retry key.
    const completed = await completeAttempt(supabase, notification, {
      status: "sent",
    });
    if (!completed) {
      log.warn("produce notification completion was stale", {
        result: "sent",
      });
      return "stale_completion";
    }

    log.info("produce notification sent");
    return "sent";
  }

  const classified = classifyPushError(pushError);
  const retryable =
    classified.retryable
    && notification.notification_cycle_attempt_count < MAX_CYCLE_ATTEMPTS;
  const delayMs = retryable
    ? notificationRetryDelayMs(
        notification.notification_cycle_attempt_count,
        classified.retryAfterMs,
      )
    : null;
  const nextAttemptAt = delayMs === null
    ? null
    : new Date(now.getTime() + delayMs).toISOString();

  const completed = await completeAttempt(supabase, notification, {
    status: "failed",
    error: classified.message,
    retryable,
    nextAttemptAt,
    httpStatus: classified.httpStatus,
    retryAfterMs: classified.retryAfterMs,
  });
  if (!completed) {
    log.warn("produce notification completion was stale", {
      result: "failed",
    });
    return "stale_completion";
  }

  log.error("produce notification attempt failed", {
    retryable,
    nextAttemptAt,
    httpStatus: classified.httpStatus,
    retryAfterMs: classified.retryAfterMs,
    error: classified.message,
  });
  return retryable ? "retry_scheduled" : "failed";
}

async function claimDueNotifications(
  supabase: AnyClient,
  limit: number,
): Promise<ProduceNotificationRecord[]> {
  // 0061: claim is scoped to this process's own environment — Production and
  // Preview share one Supabase project and must never dequeue each other's
  // notification rows. See claim_due_produce_notifications in
  // 20260806111646_pending_session_runtime_environment.sql.
  const { data, error } = await supabase.rpc(
    "claim_due_produce_notifications",
    { p_limit: limit, p_environment: getRuntimeEnvironment() },
  );
  if (error) {
    throw new Error(`due produce notification claim failed: ${error.message}`);
  }
  return (data ?? []) as ProduceNotificationRecord[];
}

export async function processDueProduceNotifications(
  supabase: AnyClient,
  push: NotificationPush = defaultPush,
  limit = 25,
  now = new Date(),
): Promise<ProduceNotificationRun> {
  const claimed = await claimDueNotifications(supabase, limit);
  const run: ProduceNotificationRun = {
    claimed: claimed.length,
    sent: 0,
    retryScheduled: 0,
    failed: 0,
    staleCompletions: 0,
    errors: 0,
  };

  for (const notification of claimed) {
    try {
      const result = await deliverClaimedProduceNotification(
        supabase,
        notification,
        push,
        now,
      );
      if (result === "sent") run.sent += 1;
      else if (result === "retry_scheduled") run.retryScheduled += 1;
      else if (result === "failed") run.failed += 1;
      else run.staleCompletions += 1;
    } catch (error) {
      // A completion-write failure intentionally leaves the row in "sending".
      // The stale lease path will reuse the same LINE retry key.
      run.errors += 1;
      logger.error("produce notification worker error", {
        correlationId: notification.correlation_id,
        produceSessionId: notification.produce_session_id,
        notificationId: notification.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return run;
}

export async function resendProduceNotification(
  supabase: AnyClient,
  produceSessionId: string,
  push: NotificationPush = defaultPush,
  now = new Date(),
): Promise<NotificationAttemptResult | "not_requeued"> {
  const { data: requeuedData, error: requeueError } = await supabase.rpc(
    "requeue_produce_notification",
    { p_produce_session_id: produceSessionId },
  );
  if (requeueError) {
    throw new Error(`produce notification requeue failed: ${requeueError.message}`);
  }
  const notification = requeuedData?.[0] as
    | ProduceNotificationRecord
    | undefined;
  if (!notification) return "not_requeued";

  return deliverClaimedProduceNotification(
    supabase,
    notification,
    push,
    now,
  );
}
