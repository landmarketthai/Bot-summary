/**
 * Delivering an answer to LINE exactly once, or reporting why it could not.
 *
 * A reply token is single-use and short-lived, and LINE has no idempotency
 * key for reply. The job therefore records `reply_started` BEFORE the call:
 *   - HTTP 2xx                      -> delivered
 *   - HTTP 400 (token expired/used) -> definitely not delivered: push
 *   - network error / 5xx / abort   -> outcome unknown: `uncertain`, never
 *                                      resent (a resend could duplicate)
 *   - a reclaimed job that is still `reply_started` (worker crashed mid-reply)
 *                                   -> `uncertain`, never resent
 * Push carries the job's stable X-Line-Retry-Key, so a push retried after an
 * ambiguous failure or a crash is de-duplicated by LINE (HTTP 409).
 * Push costs message quota and is used only when explicitly enabled.
 */
import { LinePushError, pushLineMessage } from "@/lib/line/reply";
import type { AssistantDeliveryState, AssistantJob, AssistantJobStore } from "./job-store";

export class LineDeliveryError extends Error {
  constructor(
    readonly kind: "invalid_reply_token" | "ambiguous" | "rejected",
    readonly httpStatus: number | null,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`LINE delivery ${kind}${httpStatus ? ` HTTP ${httpStatus}` : ""}`);
    this.name = "LineDeliveryError";
  }
}

export interface LineDeliveryAdapter {
  /** Throws LineDeliveryError. */
  reply(replyToken: string, text: string, signal: AbortSignal): Promise<void>;
  /** Throws LineDeliveryError. A 409 for a reused retry key is success. */
  push(to: string, text: string, retryKey: string, signal: AbortSignal): Promise<void>;
}

export const lineMessagingDelivery: LineDeliveryAdapter = {
  async reply(replyToken, text, signal) {
    let response: Response;
    try {
      response = await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
        signal,
      });
    } catch {
      throw new LineDeliveryError("ambiguous", null, false);
    }
    if (response.ok) return;
    // Drain without logging: an error body is not needed and may echo input.
    await response.text().catch(() => "");
    if (response.status === 400) throw new LineDeliveryError("invalid_reply_token", 400, false);
    throw new LineDeliveryError(
      response.status >= 500 || response.status === 429 ? "ambiguous" : "rejected",
      response.status,
      false,
    );
  },
  async push(to, text, retryKey, signal) {
    try {
      await pushLineMessage(to, text, retryKey, { signal });
    } catch (error) {
      if (error instanceof LinePushError) {
        throw new LineDeliveryError(
          error.retryable ? "ambiguous" : "rejected",
          error.httpStatus,
          error.retryable,
          error.retryAfterMs,
        );
      }
      throw new LineDeliveryError("ambiguous", null, true);
    }
  },
};

export type DeliveryResult =
  | { state: "delivered"; channel: "reply" | "push" }
  | { state: "uncertain" | "undeliverable"; reason: string }
  /** Push may still succeed later with the same retry key. */
  | { state: "retry"; reason: string; retryAfterMs: number | null }
  /** The lease was taken over; another worker owns the job now. */
  | { state: "fenced" };

export interface DeliverOptions {
  store: AssistantJobStore;
  adapter: LineDeliveryAdapter;
  pushFallbackEnabled: boolean;
  signal: AbortSignal;
  now?: number;
  /** Do not start a reply with less than this left on the token. */
  replySafetyMs?: number;
}

function replyTokenUsable(job: AssistantJob, now: number, safetyMs: number): boolean {
  if (!job.reply_token || !job.reply_token_expires_at) return false;
  const expiresAt = Date.parse(job.reply_token_expires_at);
  return Number.isFinite(expiresAt) && expiresAt - now > safetyMs;
}

export async function deliverAnswer(
  job: AssistantJob,
  leaseToken: string,
  text: string,
  options: DeliverOptions,
): Promise<DeliveryResult> {
  const { store, adapter } = options;
  const now = options.now ?? Date.now();
  const set = (from: AssistantDeliveryState[], to: AssistantDeliveryState, channel?: "reply" | "push") =>
    store.setDelivery(job.id, leaseToken, from, to, channel);

  if (job.delivery_state === "delivered") {
    return { state: "delivered", channel: job.delivery_channel ?? "reply" };
  }
  if (job.delivery_state === "uncertain" || job.delivery_state === "undeliverable") {
    return { state: job.delivery_state, reason: "already_terminal" };
  }
  if (job.delivery_state === "reply_started") {
    // A previous worker spent (or may have spent) the token and crashed
    // before recording the outcome.
    return (await set(["reply_started"], "uncertain"))
      ? { state: "uncertain", reason: "reply_outcome_unknown_after_crash" }
      : { state: "fenced" };
  }

  let pushFrom: AssistantDeliveryState[] = ["pending", "push_started"];
  if (job.delivery_state === "pending" && replyTokenUsable(job, now, options.replySafetyMs ?? 3_000)) {
    if (!await set(["pending"], "reply_started", "reply")) return { state: "fenced" };
    try {
      await adapter.reply(job.reply_token!, text, options.signal);
      return (await set(["reply_started"], "delivered", "reply"))
        ? { state: "delivered", channel: "reply" }
        : { state: "fenced" };
    } catch (error) {
      const kind = error instanceof LineDeliveryError ? error.kind : "ambiguous";
      if (kind !== "invalid_reply_token") {
        const next = kind === "rejected" ? "undeliverable" : "uncertain";
        return (await set(["reply_started"], next))
          ? { state: next, reason: kind === "rejected" ? "reply_rejected" : "reply_outcome_unknown" }
          : { state: "fenced" };
      }
      // HTTP 400: the token expired or was already used; nothing was shown.
      pushFrom = ["reply_started"];
    }
  }

  if (!options.pushFallbackEnabled) {
    return (await set([...pushFrom, "pending"], "undeliverable"))
      ? { state: "undeliverable", reason: "reply_token_expired_push_disabled" }
      : { state: "fenced" };
  }

  if (!await set(pushFrom, "push_started", "push")) return { state: "fenced" };
  try {
    await adapter.push(job.source_id, text, job.delivery_retry_key, options.signal);
    return (await set(["push_started"], "delivered", "push"))
      ? { state: "delivered", channel: "push" }
      : { state: "fenced" };
  } catch (error) {
    const deliveryError = error instanceof LineDeliveryError
      ? error
      : new LineDeliveryError("ambiguous", null, true);
    if (deliveryError.retryable) {
      // Stays push_started: the next attempt reuses the same retry key.
      return { state: "retry", reason: "push_retryable", retryAfterMs: deliveryError.retryAfterMs };
    }
    return (await set(["push_started"], "undeliverable"))
      ? { state: "undeliverable", reason: "push_rejected" }
      : { state: "fenced" };
  }
}
