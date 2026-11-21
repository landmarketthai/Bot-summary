import { createHash } from "node:crypto";
import type { PendingSession, TryFinalizeResult } from "@/lib/line/pending-session-service";
import { pushLineMessage } from "@/lib/line/reply";
import { getPendingSessionKey } from "@/lib/line/verify";
import { logger } from "@/lib/logger";

const NOTICE_TEXT = "⏸️ รายการรอตรวจสอบและยังไม่ได้บันทึก\nระบบส่งข้อความตรวจสอบทางแชตส่วนตัวแล้ว";
const NOTICE_MAX_AGE_MS = 23 * 60 * 60 * 1_000;

type NoticeSnapshot = Pick<PendingSession,
  "source_id" | "session_key" | "line_user_id" | "session_generation" | "close_requested_at"
>;
type NoticePush = (
  to: string,
  text: string,
  retryKey: string,
  options: { signal: AbortSignal },
) => Promise<unknown>;

function reviewNoticeRetryKey(groupId: string, generation: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["produce-finalizer-review-group-notice", groupId, generation]))
    .digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // UUID v8 (custom name hash)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex", 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildFinalizerReviewGroupNotice(
  snapshot: NoticeSnapshot,
  result: TryFinalizeResult | null,
  allowedGroupIds: string,
  nowMs: number,
): { to: string; text: string; retryKey: string } | null {
  if (result?.status !== "validation_held") return null;
  if (result.reason !== "entry_review_presented"
    && result.reason !== "entry_review_partially_presented") return null;

  const { source_id: groupId, line_user_id: userId, session_key: sessionKey } = snapshot;
  if (!groupId || groupId === "unknown" || !userId || groupId === userId) return null;
  if (sessionKey !== getPendingSessionKey({ type: "group", groupId, userId })) return null;
  if (!allowedGroupIds.split(/[\s,]+/).includes(groupId)) return null;

  const generation = snapshot.session_generation;
  const ageMs = nowMs - Date.parse(snapshot.close_requested_at ?? "");
  // Anchor to the first close so all attempts fit within LINE's 24-hour retry-key lifetime.
  if (!generation || !Number.isFinite(ageMs) || ageMs < 0 || ageMs >= NOTICE_MAX_AGE_MS) return null;

  return { to: groupId, text: NOTICE_TEXT, retryKey: reviewNoticeRetryKey(groupId, generation) };
}

/** Best-effort status after the finalizer records private review presentation. */
export async function notifyFinalizerReviewGroup(
  snapshot: NoticeSnapshot,
  result: TryFinalizeResult | null,
  push: NoticePush = pushLineMessage,
): Promise<void> {
  const notice = buildFinalizerReviewGroupNotice(
    snapshot,
    result,
    process.env.PRODUCE_FINALIZER_REVIEW_NOTICE_GROUP_IDS ?? "",
    Date.now(),
  );
  if (!notice) return;

  try {
    await push(notice.to, notice.text, notice.retryKey, { signal: AbortSignal.timeout(3_000) });
  } catch {
    logger.warn("produce finalizer group review notice failed");
  }
}
