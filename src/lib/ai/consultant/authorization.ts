/**
 * Consultant authorization. Runs BEFORE any workflow query and is the only
 * place a ConsultantScope is created.
 *
 * Identity comes from the signed LINE webhook (source id + user id). The
 * question text ("รายการของผม", "ของน้อย") and model tool arguments are never
 * treated as proof of who someone is.
 *
 * Chats: BOT_SUMMARY_ANALYST_LINE_SOURCE_IDS (management chats: analyst +
 * consultant) or BOT_SUMMARY_CONSULTANT_LINE_SOURCE_IDS (worker chats:
 * consultant only — no sales or settlement tools).
 *
 * Initial scope is deliberately narrow:
 * - everyone: only documents they sent themselves, in the chat they ask from;
 * - supervisors (explicit env allowlist of LINE user ids): documents of the
 *   chat they ask from; from a management (analyst) chat or a DM, documents of
 *   every allowlisted chat. Without a staff name, only their own documents.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getRuntimeEnvironment, type RuntimeEnvironment } from "@/lib/runtime-environment";
import { parseBotSummaryAnalystSourceIds } from "@/lib/ai/line-command";
import type { ConsultantRequester, ConsultantScope } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

export function isBotSummaryConsultantEnabled(
  value = process.env.BOT_SUMMARY_CONSULTANT_ENABLED,
): boolean {
  return value === "true";
}

export function parseConsultantSupervisorIds(
  value = process.env.BOT_SUMMARY_CONSULTANT_SUPERVISOR_LINE_USER_IDS,
): Set<string> {
  return new Set((value ?? "").split(/[,\s]+/u).map((part) => part.trim()).filter(Boolean));
}

/** Worker chats that get the consultant but NOT the sales/settlement analyst. */
export function parseConsultantSourceIds(
  value = process.env.BOT_SUMMARY_CONSULTANT_LINE_SOURCE_IDS,
): Set<string> {
  return parseConsultantSupervisorIds(value);
}

/** Every chat the consultant may answer in: analyst chats plus consultant-only chats. */
export function consultantAllowedSourceIds(): Set<string> {
  return new Set([...parseBotSummaryAnalystSourceIds(), ...parseConsultantSourceIds()]);
}

export type ScopeResolution =
  | { ok: true; scope: ConsultantScope }
  | { ok: false; reason: "no_user" | "source_not_allowed" };

export interface ScopeResolutionOptions {
  allowedSourceIds?: ReadonlySet<string>;
  /** Management (analyst) chats where a supervisor may see every allowlisted chat. */
  managementSourceIds?: ReadonlySet<string>;
  supervisorIds?: ReadonlySet<string>;
  runtimeEnvironment?: RuntimeEnvironment;
}

/** Trusted staff label for a LINE user, or null when unmapped/inactive/unreadable. */
export async function lookupStaffLabel(
  supabase: AnyClient,
  lineUserId: string,
): Promise<string | null> {
  // ponytail: an unreadable mapping only removes the name shortcut; own-row
  // access still works through line_user_id, so this fails closed.
  let data: { staff_label?: unknown; active?: unknown } | null = null;
  try {
    const result = await supabase
      .from("line_operator_identities")
      .select("staff_label, active")
      .eq("line_user_id", lineUserId)
      .maybeSingle();
    if (result.error) return null;
    data = result.data;
  } catch {
    return null;
  }
  if (!data || data.active !== true) return null;
  const label = typeof data.staff_label === "string" ? data.staff_label.trim() : "";
  return label || null;
}

export async function resolveConsultantScope(
  supabase: AnyClient,
  requester: ConsultantRequester,
  options: ScopeResolutionOptions = {},
): Promise<ScopeResolution> {
  const lineUserId = requester.lineUserId.trim();
  const sourceId = requester.sourceId.trim();
  if (!lineUserId) return { ok: false, reason: "no_user" };

  const allowed = options.allowedSourceIds ?? consultantAllowedSourceIds();
  if (!sourceId || !allowed.has(sourceId)) return { ok: false, reason: "source_not_allowed" };

  const runtimeEnvironment = options.runtimeEnvironment ?? getRuntimeEnvironment();
  const staffLabel = await lookupStaffLabel(supabase, lineUserId);
  const supervisors = options.supervisorIds ?? parseConsultantSupervisorIds();

  if (supervisors.has(lineUserId)) {
    // The reply is posted where the question was asked: from a worker group a
    // supervisor sees only that group; from a management chat or a DM, all.
    const management = options.managementSourceIds ?? parseBotSummaryAnalystSourceIds();
    const seesAllChats = management.has(sourceId) || requester.sourceType === "user";
    return {
      ok: true,
      scope: {
        kind: "supervisor",
        lineUserId,
        sourceIds: seesAllChats ? [...allowed] : [sourceId],
        staffLabel,
        runtimeEnvironment,
      },
    };
  }
  return {
    ok: true,
    scope: { kind: "own", lineUserId, sourceId, staffLabel, runtimeEnvironment },
  };
}

function compactName(value: string): string {
  return value.normalize("NFC").replace(/[\s​-‍﻿]+/gu, "");
}

/** Comparable staff name; a polite prefix is dropped only when a name remains ("พี่" stays "พี่"). */
export function normalizeStaffName(value: string): string {
  const compact = compactName(value);
  return compact.replace(/^(?:พี่|น้อง|คุณ|เจ๊|ป้า|ลุง)/u, "") || compact;
}

/**
 * May this scope read documents of `requestedStaff`?
 * `self`    the name is the requester's own trusted label (row filter stays line_user_id).
 * `allowed` supervisor scope; rows are filtered by staff name inside allowlisted chats.
 * `denied`  anyone else asking about another worker.
 */
export function authorizeStaffQuery(
  scope: ConsultantScope,
  requestedStaff: string,
): "self" | "allowed" | "denied" {
  const target = normalizeStaffName(requestedStaff);
  if (!target) return "self";
  if (scope.staffLabel && compactName(scope.staffLabel) === compactName(requestedStaff)) return "self";
  if (scope.staffLabel && normalizeStaffName(scope.staffLabel) === target) return "self";
  return scope.kind === "supervisor" ? "allowed" : "denied";
}
