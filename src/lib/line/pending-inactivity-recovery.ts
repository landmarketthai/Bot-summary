/**
 * Inactivity-based lifecycle for OPEN pending Produce sessions.
 *
 * Every existing sweep (finalizer, close recovery, notification delivery)
 * only ever looks at a session that was already CLOSED — next_attempt_at is
 * non-NULL only after a close boundary is written. An operator who opens a
 * draft and walks away leaves an OPEN, un-closed row that no sweep will ever
 * touch: it holds the active-session lock forever (see
 * src/lib/produce/cancel-active-draft.ts) and is invisible everywhere else.
 *
 * Two RPCs close that gap (20260829090000_produce_pending_inactivity_lifecycle.sql),
 * both keyed off pending_sessions.updated_at:
 *
 *   sweep_pending_session_inactivity_warnings   25 minutes idle -> one LINE
 *                                                warning, re-armed by the next
 *                                                real activity
 *   sweep_pending_session_inactivity_expiry     30 minutes idle -> terminal.
 *                                                Zero accepted items ->
 *                                                expired_empty_draft. One or
 *                                                more -> failed_closed /
 *                                                expired_incomplete.
 *
 * The warning push reuses the SAME LINE push primitive
 * (src/lib/line/reply.ts::pushLineMessage) the notification outbox delivery
 * uses — no new outbox table, no new delivery mechanism. A push failure is
 * logged and never crashes the cron or blocks the other sweep.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { getRuntimeEnvironment } from "@/lib/runtime-environment";
import { logger } from "@/lib/logger";
import { pushLineMessage } from "@/lib/line/reply";

type Supabase = SupabaseClient<Database>;

/** Matches the RPC defaults in 20260829090000_produce_pending_inactivity_lifecycle.sql. */
export const INACTIVITY_WARN_AFTER = "25 minutes";
export const INACTIVITY_EXPIRE_AFTER = "30 minutes";

export const INACTIVITY_WARNING_TEXT =
  "⚠️ รายการนี้ไม่มีการอัปเดตมา 25 นาที\n"
  + "Session จะหมดอายุในอีก 5 นาที\n"
  + "หากยังกรอกอยู่ ให้ส่งรายการถัดไปได้เลย ระบบจะต่อเวลาให้อัตโนมัติ\n"
  + "หากครบแล้ว ส่ง “จบรายการเบิก” หรือ “จบรายการชั่งคืน” ให้ตรงประเภท";

export const INACTIVITY_EXPIRED_TEXT =
  "⚠️ รายการหมดอายุหลังไม่มีการอัปเดต 30 นาที ยังไม่ได้บันทึกยอดเงิน\n"
  + "ข้อความเดิมยังเก็บไว้ กรุณาเปิดหัวรายการวันเดิม ตลาดเดิม และประเภทเดิม แล้วส่งรายการเดิมให้ครบและจบรายการอีกครั้ง\n"
  + "ตรวจสรุปเดิมก่อนส่งซ้ำ ระบบตรวจรายการซ้ำก่อนบันทึก ห้ามใช้คำสั่งเบิกเพิ่มหรือชั่งคืนเพิ่มเพื่อส่งชุดเดิมซ้ำ";

export interface PendingInactivityWarningRun {
  claimed: number;
  pushed: number;
  pushFailed: number;
}

export interface PendingInactivityExpiryRun {
  expired: number;
  expiredEmptyDraft: number;
  expiredIncomplete: number;
}

/**
 * True only for "this function is not installed". Matched on the error CODE,
 * not on message text, exactly like recoverStrandedPendingCloses: a deploy
 * that reaches a database ahead of 20260829090000 has nothing stranded yet,
 * and the sweep is not the reason the rest of the cron should fail.
 */
function isMissingFunctionError(error: { code?: string | null }): boolean {
  return error.code === "42883" || error.code === "PGRST202";
}

interface InactivityWarningRow {
  session_key: string;
  session_generation: string;
  line_user_id: string | null;
  source_id: string | null;
  updated_at: string;
}

interface InactivityExpiryRow {
  session_key: string;
  session_generation: string;
  line_user_id: string | null;
  source_id: string | null;
  accountability_round_id: string | null;
  outcome: "expired_empty_draft" | "failed_closed";
  accepted_item_count: number;
}

type WarningPush = (to: string, text: string) => Promise<unknown>;

const defaultPush: WarningPush = (to, text) => pushLineMessage(to, text);

export async function sweepPendingSessionInactivityWarnings(
  supabase: Supabase,
  push: WarningPush = defaultPush,
  limit = 25,
): Promise<PendingInactivityWarningRun> {
  const { data, error } = await supabase.rpc(
    "sweep_pending_session_inactivity_warnings",
    {
      p_limit: limit,
      p_runtime_environment: getRuntimeEnvironment(),
      p_warn_after: INACTIVITY_WARN_AFTER,
      // Shared with the expiry sweep so a row already expiry-eligible is
      // never warned — see the migration's P3 fix comment.
      p_expire_after: INACTIVITY_EXPIRE_AFTER,
    },
  );

  if (error) {
    if (isMissingFunctionError(error)) {
      logger.warn("produce.inactivity.warning_sweep_unavailable", {
        code: error.code ?? null,
        message: error.message,
      });
      return { claimed: 0, pushed: 0, pushFailed: 0 };
    }
    throw new Error(`inactivity warning sweep failed: ${error.message}`);
  }

  const rows = (data ?? []) as InactivityWarningRow[];
  const run: PendingInactivityWarningRun = {
    claimed: rows.length,
    pushed: 0,
    pushFailed: 0,
  };

  for (const row of rows) {
    // Group/room source is the push target when present, exactly like the
    // notification outbox delivery (source_id); a DM-only legacy row falls
    // back to the sender's own LINE user id.
    const to = row.source_id ?? row.line_user_id;
    if (!to) {
      run.pushFailed += 1;
      logger.warn("produce.inactivity.warning_push_skipped_no_target", {
        sessionKey: row.session_key,
        sessionGeneration: row.session_generation,
      });
      continue;
    }

    try {
      await push(to, INACTIVITY_WARNING_TEXT);
      run.pushed += 1;
      logger.info("produce.inactivity.warning_pushed", {
        sessionKey: row.session_key,
        sessionGeneration: row.session_generation,
        updatedAt: row.updated_at,
      });
    } catch (pushError) {
      // ponytail: inactivity_warning_sent_at was already set inside the SAME
      // sweep transaction that returned this row (20260829090000) — before,
      // not after, this push. A failure here therefore loses at most one
      // advisory warning (re-armed by the next real activity, or superseded
      // by the 30-minute expiry sweep) rather than risking a resend storm by
      // retrying "did it actually land". Advisory only, no financial impact.
      run.pushFailed += 1;
      logger.error("produce.inactivity.warning_push_failed", {
        sessionKey: row.session_key,
        sessionGeneration: row.session_generation,
        error: pushError instanceof Error ? pushError.message : String(pushError),
      });
    }
  }

  return run;
}

export async function sweepPendingSessionInactivityExpiry(
  supabase: Supabase,
  limit = 25,
  push: WarningPush = defaultPush,
): Promise<PendingInactivityExpiryRun> {
  const { data, error } = await supabase.rpc(
    "sweep_pending_session_inactivity_expiry",
    {
      p_limit: limit,
      p_runtime_environment: getRuntimeEnvironment(),
      p_expire_after: INACTIVITY_EXPIRE_AFTER,
    },
  );

  if (error) {
    if (isMissingFunctionError(error)) {
      logger.warn("produce.inactivity.expiry_sweep_unavailable", {
        code: error.code ?? null,
        message: error.message,
      });
      return { expired: 0, expiredEmptyDraft: 0, expiredIncomplete: 0 };
    }
    throw new Error(`inactivity expiry sweep failed: ${error.message}`);
  }

  const rows = (data ?? []) as InactivityExpiryRow[];

  for (const row of rows) {
    logger.info("produce.inactivity.expired", {
      sessionKey: row.session_key,
      sessionGeneration: row.session_generation,
      accountabilityRoundId: row.accountability_round_id,
      outcome: row.outcome,
      acceptedItemCount: row.accepted_item_count,
    });
    const to = row.source_id ?? row.line_user_id;
    if (row.accepted_item_count > 0 && to) {
      try {
        await push(to, INACTIVITY_EXPIRED_TEXT);
      } catch (error) {
        logger.error("produce.inactivity.expiry_push_failed", {
          sessionKey: row.session_key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    expired: rows.length,
    expiredEmptyDraft: rows.filter((row) => row.outcome === "expired_empty_draft").length,
    expiredIncomplete: rows.filter((row) => row.outcome === "failed_closed").length,
  };
}
