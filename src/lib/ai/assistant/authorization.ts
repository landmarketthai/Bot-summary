/**
 * Authorization for @Botsummary V1, enforced on the server before any
 * business query runs. Identity and audience come from the signed LINE
 * webhook (stored on the job); the question text and the model's tool
 * arguments can only NARROW what the scope allows.
 *
 * V1 (owner decision): approved LINE groups only.
 *   An approved group is a group on the signed-webhook source allowlist WITH
 *   an active ai_assistant_group_policies row that grants every category
 *   (allow_financial AND allow_person_specific). Every member of it, whoever
 *   they are, asks under the GROUP's scope: every supported read-only tool,
 *   in all markets or the policy's markets. No per-user grant is read.
 *   A policy row that withholds a category is not supported in V1 and is
 *   treated as no approval (fail closed).
 *   1:1 chats and groups without an approving policy get a fixed notice.
 *
 * The tool list is an allowlist: a new tool is denied until listed.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { canonicalMarketLabel } from "@/lib/market";
import { compactToolOutput, type AnalystToolExecutor } from "@/lib/ai/readonly-analyst";
import {
  executeReadonlyAnalystTool,
  type ReadonlyAnalystToolName,
  type ReadonlyAnalystToolRequest,
  type ToolDataScope,
} from "@/lib/ai/readonly-tools";

type Supabase = SupabaseClient<Database>;

/** The scope a question is answered under: the approved group's. */
export interface AssistantScope {
  lineUserId: string;
  /** Canonical market labels; null = every market. */
  markets: ReadonlySet<string> | null;
}

/** Every tool a member of an approved group may use. */
export const GROUP_TOOLS: ReadonlySet<ReadonlyAnalystToolName> = new Set([
  "get_daily_summary",
  "get_market_summary",
  "get_stock_summary",
  "get_market_stock",
  "get_pending_items",
  "get_staff_settlement",
  "get_market_settlement",
  "get_settlement_overview",
  "compare_daily_sales",
  "get_staff_produce",
  "get_slip_status",
  "get_white_sheet_status",
]);

export interface GroupPolicy {
  sourceId: string;
  /** Canonical market labels; null = every market. */
  markets: ReadonlySet<string> | null;
}

export type GroupPolicyResolution = { ok: true; policy: GroupPolicy | null } | { ok: false };

/** The approving policy of a group, or null when it has none (or one V1 does not support). */
export async function resolveGroupPolicy(supabase: Supabase, sourceId: string): Promise<GroupPolicyResolution> {
  const { data, error } = await supabase.rpc("get_ai_assistant_group_policy", { p_source_id: sourceId });
  if (error) return { ok: false };
  const row = (data ?? [])[0];
  if (!row || !row.allow_financial || !row.allow_person_specific) return { ok: true, policy: null };
  const markets = row.all_markets
    ? null
    : new Set(row.market_labels.map((label) => canonicalMarketLabel(label)).filter(Boolean));
  if (markets !== null && markets.size === 0) return { ok: true, policy: null };
  return { ok: true, policy: { sourceId: row.source_id, markets } };
}

/** Everything one job may do. */
export interface JobAccess {
  scope: AssistantScope;
  allowedTools: ReadonlySet<ReadonlyAnalystToolName>;
  groupPolicy: GroupPolicy;
  /** SHA-256 hex binding memory and recorded answers to this exact access. */
  scopeKey: string;
}

export type JobAccessDecision =
  | { ok: true; access: JobAccess }
  | { ok: false; reason: "direct_chat" | "group_not_permitted" };

export function decideJobAccess(input: {
  lineUserId: string;
  sourceType: "user" | "group" | "room";
  sourceId: string;
  groupPolicy: GroupPolicy | null;
}): JobAccessDecision {
  if (input.sourceType === "user") return { ok: false, reason: "direct_chat" };
  const policy = input.groupPolicy;
  if (!policy) return { ok: false, reason: "group_not_permitted" };
  const scope: AssistantScope = { lineUserId: input.lineUserId, markets: policy.markets };
  const scopeKey = createHash("sha256").update(JSON.stringify({
    v: 3,
    user: input.lineUserId,
    source: input.sourceId,
    markets: policy.markets === null ? null : [...policy.markets].sort(),
    tools: [...GROUP_TOOLS].sort(),
  })).digest("hex");
  return { ok: true, access: { scope, allowedTools: GROUP_TOOLS, groupPolicy: policy, scopeKey } };
}

export function toolDataScope(scope: AssistantScope): ToolDataScope {
  return { markets: scope.markets };
}

export type ToolDenialReason = "tool_not_permitted" | "market_not_permitted";

export type ToolAuthorization =
  | { ok: true; request: ReadonlyAnalystToolRequest }
  | { ok: false; reason: ToolDenialReason };

/**
 * Decide one tool request: the tool must be allowed and a market argument
 * must be inside the scope. The data reader enforces the market scope again
 * at the source.
 */
export function authorizeToolRequest(
  scope: AssistantScope,
  request: ReadonlyAnalystToolRequest,
  allowedTools: ReadonlySet<ReadonlyAnalystToolName> = GROUP_TOOLS,
): ToolAuthorization {
  if (!allowedTools.has(request.tool)) return { ok: false, reason: "tool_not_permitted" };
  if ("market" in request && typeof request.market === "string" && request.market.trim() && scope.markets !== null) {
    if (!scope.markets.has(canonicalMarketLabel(request.market))) return { ok: false, reason: "market_not_permitted" };
  }
  return { ok: true, request };
}

export function scopeInstructions(access: JobAccess): string[] {
  const { scope } = access;
  return [
    "สิทธิ์ของผู้ถาม: สมาชิกกลุ่ม LINE ที่ได้รับอนุมัติ (ทุกคนในกลุ่มใช้สิทธิ์ของกลุ่มเดียวกัน)",
    scope.markets === null ? "ดูได้ทุกตลาด" : `ดูได้เฉพาะตลาด: ${[...scope.markets].join(", ")}`,
    "คำตอบนี้จะแสดงในกลุ่ม LINE ให้ทุกคนในกลุ่มเห็น",
  ];
}

/** Reads authorized data; the default is the real read-only tools. */
export type ScopedDataReader = (
  request: ReadonlyAnalystToolRequest,
  scope: ToolDataScope,
) => Promise<Record<string, unknown>>;

export function readonlyDataReader(supabase: Supabase): ScopedDataReader {
  return async (request, scope) => compactToolOutput(await executeReadonlyAnalystTool(supabase, request, scope));
}

/** Executor the model's tool calls go through. Refusals never reach the data reader. */
export function createScopedToolExecutor(
  readData: ScopedDataReader,
  access: JobAccess,
  onDecision?: (tool: ReadonlyAnalystToolName, decision: "allowed" | ToolDenialReason) => void,
): AnalystToolExecutor {
  return async (request) => {
    const decision = authorizeToolRequest(access.scope, request, access.allowedTools);
    if (!decision.ok) {
      onDecision?.(request.tool, decision.reason);
      return { tool: request.tool, status: "forbidden", reason: decision.reason };
    }
    onDecision?.(request.tool, "allowed");
    return readData(decision.request, toolDataScope(access.scope));
  };
}
