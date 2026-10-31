/**
 * Webhook side of @Botsummary: turn a LINE question into a durable job.
 *
 * This is the only AI work the webhook (and the ordered per-chat queue) does:
 * one idempotent INSERT. The model, the tools and the LINE reply all happen in
 * the worker, so a slow or failing model can no longer delay produce, slip or
 * white-sheet events of the same chat.
 */
import { bangkokBusinessDateFromTimestamp, bangkokBusinessDateNow } from "@/lib/business-date";
import type { LineMessageEvent } from "@/lib/line/types";
import type { AssistantJobRequest, AssistantJobStore, EnqueueOutcome } from "./job-store";

/**
 * LINE recommends using a reply token within about a minute. The worker
 * does not START a reply after this point (counted from the earlier of the
 * LINE event time and receipt) and falls back to push when that is enabled.
 */
export const REPLY_TOKEN_USABLE_MS = 50_000;
const MAX_QUESTION_CHARS = 1000;

export interface AssistantDispatchInput {
  event: LineMessageEvent;
  question: string;
  destination: string;
  rawMessageId: string | null;
}

export type AssistantDispatchOutcome =
  | EnqueueOutcome
  | { outcome: "no_user"; jobId: null }
  | { outcome: "error"; jobId: null };

export type AssistantDispatcher = (input: AssistantDispatchInput) => Promise<AssistantDispatchOutcome>;

export const ASSISTANT_BUSY_REPLY =
  "ขอเวลาตอบคำถามก่อนหน้าให้เสร็จก่อนนะครับ แล้วค่อยถามต่อได้เลย";
export const ASSISTANT_QUEUE_FULL_REPLY =
  "ตอนนี้ @Botsummary มีคำถามรอตอบจำนวนมาก กรุณาลองถามใหม่อีกครั้งในไม่กี่นาทีครับ";
export const ASSISTANT_NO_USER_REPLY =
  "@Botsummary ระบุตัวผู้ถามจากแชทนี้ไม่ได้ กรุณาเพิ่มบอทเป็นเพื่อนแล้วถามใหม่ครับ";

export function buildAssistantJobRequest(
  input: AssistantDispatchInput,
  now = Date.now(),
): AssistantJobRequest | null {
  const { event } = input;
  const source = event.source;
  const lineUserId = source.userId?.trim();
  if (!lineUserId) return null;
  const sourceId = source.type === "group"
    ? source.groupId
    : source.type === "room"
      ? source.roomId
      : lineUserId;
  if (!sourceId) return null;

  const eventMs = Number.isFinite(event.timestamp) && event.timestamp > 0 ? event.timestamp : now;
  const issuedAt = Math.min(eventMs, now);
  return {
    lineEventId: event.webhookEventId,
    rawMessageId: input.rawMessageId,
    destination: input.destination,
    sourceType: source.type,
    sourceId,
    lineUserId,
    question: input.question.trim().slice(0, MAX_QUESTION_CHARS),
    askedBusinessDate: bangkokBusinessDateFromTimestamp(eventMs) ?? bangkokBusinessDateNow(),
    eventTimestampMs: eventMs,
    replyToken: event.replyToken ?? null,
    replyTokenExpiresAt: event.replyToken
      ? new Date(issuedAt + REPLY_TOKEN_USABLE_MS).toISOString()
      : null,
  };
}

export function createAssistantDispatcher(store: AssistantJobStore): AssistantDispatcher {
  return async (input) => {
    const request = buildAssistantJobRequest(input);
    if (!request) return { outcome: "no_user", jobId: null };
    return store.enqueue(request);
  };
}

/** The immediate webhook reply for an enqueue outcome; null = the worker replies. */
export function dispatchReplyText(outcome: AssistantDispatchOutcome["outcome"], temporaryErrorText: string): string | null {
  switch (outcome) {
    case "queued":
    case "duplicate":
      return null;
    case "rate_limited":
      return ASSISTANT_BUSY_REPLY;
    case "queue_full":
      return ASSISTANT_QUEUE_FULL_REPLY;
    case "no_user":
      return ASSISTANT_NO_USER_REPLY;
    case "error":
      return temporaryErrorText;
  }
}
