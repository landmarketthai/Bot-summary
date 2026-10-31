/**
 * Authorization for @Botsummary, enforced on the server before any business
 * query runs. Identity and audience come from the signed LINE webhook (stored
 * on the job); the question text and the model's tool arguments only NARROW
 * what the scope already allows.
 *
 * Approved LINE group (owner decision, 2026-10-31): a group on the
 * signed-webhook source allowlist WITH an active ai_assistant_group_policies
 * row. Every member of it, whoever they are, shares the GROUP's scope — its
 * markets and categories — for every supported business tool, staff records
 * included. No per-user grant is read for a group question, so one member's
 * personal grant can neither authorize nor widen what a group sees.
 *
 * Any other group: refused (or, when private delivery is enabled, answered
 * 1:1 to the asker under the asker's own grant — never into the group).
 *
 * 1:1 chat: the asker's own grant.
 *   supervisor  env allowlist BOT_SUMMARY_ASSISTANT_SUPERVISOR_LINE_USER_IDS
 *               (all markets) or an active grant with role supervisor (its
 *               markets): every tool inside those markets.
 *   staff       active grant with role staff: only owner-scoped tools
 *               (OWNER_SCOPED_TOOLS), pinned to their own staff_label.
 *   no grant    nothing.
 *
 * Tool lists are allowlists: a new tool is denied until listed.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { canonicalMarketLabel } from "@/lib/market";
import { compactToolOutput, type AnalystToolExecutor } from "@/lib/ai/readonly-analyst";
import {
  executeReadonlyAnalystTool,
  normalizeStaffName,
  OWNER_SCOPED_TOOLS,
  type ReadonlyAnalystToolName,
  type ReadonlyAnalystToolRequest,
  type ToolDataScope,
} from "@/lib/ai/readonly-tools";

type Supabase = SupabaseClient<Database>;

export interface AssistantScope {
  lineUserId: string;
  /** group_member: a member of an approved group, scoped by the group policy. */
  role: "supervisor" | "staff" | "group_member";
  /** Trusted label for own-data questions; required for staff. */
  staffLabel: string | null;
  /** Canonical market labels; null = every market. */
  markets: ReadonlySet<string> | null;
  grantSource: "env_supervisor" | "grant" | "group_policy";
}

export type ScopeResolution =
  | { ok: true; scope: AssistantScope }
  | { ok: false; reason: "no_user" | "no_grant" | "grant_lookup_failed" };

export const SUPERVISOR_TOOLS: ReadonlySet<ReadonlyAnalystToolName> = new Set([
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

export const STAFF_TOOLS: ReadonlySet<ReadonlyAnalystToolName> = OWNER_SCOPED_TOOLS;

/**
 * What a tool's output can disclose. `financial`: money figures or cash
 * results. `person`: rows or names of individual staff members.
 */
export const TOOL_SENSITIVITY: Readonly<Record<ReadonlyAnalystToolName, { financial: boolean; person: boolean }>> = {
  get_daily_summary: { financial: true, person: false },
  get_market_summary: { financial: true, person: false },
  compare_daily_sales: { financial: true, person: false },
  get_market_settlement: { financial: true, person: false },
  get_settlement_overview: { financial: true, person: true },
  get_staff_settlement: { financial: true, person: true },
  get_staff_produce: { financial: false, person: true },
  get_pending_items: { financial: false, person: true },
  get_slip_status: { financial: false, person: true },
  get_stock_summary: { financial: false, person: false },
  get_market_stock: { financial: false, person: false },
  get_white_sheet_status: { financial: false, person: false },
};

/** Words a requester uses for themself; resolved to their own trusted label. */
const SELF_REFERENCES = new Set(["ผม", "ฉัน", "หนู", "เรา", "ตัวเอง", "กู", "ข้า", "me", "myself"]);

export function parseSupervisorLineUserIds(
  value = process.env.BOT_SUMMARY_ASSISTANT_SUPERVISOR_LINE_USER_IDS,
): Set<string> {
  return new Set((value ?? "").split(/[,\s]+/u).map((part) => part.trim()).filter(Boolean));
}

function canonicalMarkets(labels: readonly string[]): Set<string> {
  return new Set(labels.map((label) => canonicalMarketLabel(label)).filter(Boolean));
}

export async function resolveAssistantScope(
  supabase: Supabase,
  lineUserId: string,
  supervisorIds: ReadonlySet<string> = parseSupervisorLineUserIds(),
): Promise<ScopeResolution> {
  const userId = lineUserId.trim();
  if (!userId) return { ok: false, reason: "no_user" };
  if (supervisorIds.has(userId)) {
    return {
      ok: true,
      scope: { lineUserId: userId, role: "supervisor", staffLabel: null, markets: null, grantSource: "env_supervisor" },
    };
  }

  const { data, error } = await supabase.rpc("get_ai_assistant_user_grant", { p_line_user_id: userId });
  if (error) return { ok: false, reason: "grant_lookup_failed" };
  const grant = (data ?? [])[0];
  if (!grant) return { ok: false, reason: "no_grant" };
  const markets = grant.all_markets ? null : canonicalMarkets(grant.market_labels);
  if (markets !== null && markets.size === 0) return { ok: false, reason: "no_grant" };
  if (grant.role === "staff" && !grant.staff_label?.trim()) return { ok: false, reason: "no_grant" };
  return {
    ok: true,
    scope: {
      lineUserId: userId,
      role: grant.role,
      staffLabel: grant.staff_label?.trim() || null,
      markets,
      grantSource: "grant",
    },
  };
}

export interface GroupPolicy {
  sourceId: string;
  allowFinancial: boolean;
  allowPersonSpecific: boolean;
  /** Canonical market labels; null = every market. */
  markets: ReadonlySet<string> | null;
}

export type GroupPolicyResolution = { ok: true; policy: GroupPolicy | null } | { ok: false };

export async function resolveGroupPolicy(supabase: Supabase, sourceId: string): Promise<GroupPolicyResolution> {
  const { data, error } = await supabase.rpc("get_ai_assistant_group_policy", { p_source_id: sourceId });
  if (error) return { ok: false };
  const row = (data ?? [])[0];
  if (!row) return { ok: true, policy: null };
  const markets = row.all_markets ? null : canonicalMarkets(row.market_labels);
  if (markets !== null && markets.size === 0) return { ok: true, policy: null };
  return {
    ok: true,
    policy: { sourceId: row.source_id, allowFinancial: row.allow_financial, allowPersonSpecific: row.allow_person_specific, markets },
  };
}

export function roleTools(scope: AssistantScope): ReadonlySet<ReadonlyAnalystToolName> {
  return scope.role === "staff" ? STAFF_TOOLS : SUPERVISOR_TOOLS;
}

/** Everything one job may do and where its answer may go. */
export interface JobAccess {
  /** Effective scope: the asker's scope, capped by the group policy. */
  scope: AssistantScope;
  allowedTools: ReadonlySet<ReadonlyAnalystToolName>;
  deliverTo: "chat" | "private";
  audience: "private_chat" | "group_policy" | "private_from_group";
  groupPolicy: GroupPolicy | null;
  /** SHA-256 hex binding memory and recorded answers to this exact access. */
  scopeKey: string;
}

export type JobAccessDecision =
  | { ok: true; access: JobAccess }
  | { ok: false; reason: "group_not_permitted" | "no_grant" };

function intersectMarkets(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): ReadonlySet<string> | null {
  if (a === null) return b;
  if (b === null) return a;
  return new Set([...a].filter((market) => b.has(market)));
}

function scopeKeyOf(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** The shared scope every member of an approved group asks under. */
export function groupMemberScope(lineUserId: string, policy: GroupPolicy): AssistantScope {
  return { lineUserId, role: "group_member", staffLabel: null, markets: policy.markets, grantSource: "group_policy" };
}

export function decideJobAccess(input: {
  lineUserId: string;
  /** The asker's own grant; never consulted for an approved group. */
  scope: AssistantScope | null;
  sourceType: "user" | "group" | "room";
  sourceId: string;
  groupPolicy: GroupPolicy | null;
  privateDeliveryEnabled: boolean;
}): JobAccessDecision {
  let effective: AssistantScope;
  let allowedTools: ReadonlySet<ReadonlyAnalystToolName>;
  let deliverTo: JobAccess["deliverTo"] = "chat";
  let audience: JobAccess["audience"] = "private_chat";
  let policy: GroupPolicy | null = null;

  if (input.sourceType !== "user" && input.groupPolicy) {
    policy = input.groupPolicy;
    effective = groupMemberScope(input.lineUserId, policy);
    allowedTools = new Set([...SUPERVISOR_TOOLS].filter((tool) => {
      const sensitivity = TOOL_SENSITIVITY[tool];
      if (!sensitivity) return false;
      return (!sensitivity.financial || policy!.allowFinancial) && (!sensitivity.person || policy!.allowPersonSpecific);
    }));
    if ((effective.markets !== null && effective.markets.size === 0) || allowedTools.size === 0) {
      return { ok: false, reason: "group_not_permitted" };
    }
    audience = "group_policy";
  } else if (input.sourceType !== "user") {
    if (!input.privateDeliveryEnabled) return { ok: false, reason: "group_not_permitted" };
    if (!input.scope) return { ok: false, reason: "no_grant" };
    effective = input.scope;
    allowedTools = roleTools(input.scope);
    deliverTo = "private";
    audience = "private_from_group";
  } else {
    if (!input.scope) return { ok: false, reason: "no_grant" };
    effective = input.scope;
    allowedTools = roleTools(input.scope);
  }

  const scopeKey = scopeKeyOf({
    v: 2,
    user: input.lineUserId,
    role: effective.role,
    staff: effective.staffLabel,
    markets: effective.markets === null ? null : [...effective.markets].sort(),
    tools: [...allowedTools].sort(),
    deliverTo,
    audience,
    policy: policy ? { source: policy.sourceId, financial: policy.allowFinancial, person: policy.allowPersonSpecific } : null,
  });
  return { ok: true, access: { scope: effective, allowedTools, deliverTo, audience, groupPolicy: policy, scopeKey } };
}

export function toolDataScope(scope: AssistantScope): ToolDataScope {
  return { markets: scope.markets, ownerStaff: scope.role === "staff" ? scope.staffLabel : null };
}

export type ToolDenialReason = "tool_not_permitted" | "other_staff" | "market_not_permitted";

export type ToolAuthorization =
  | { ok: true; request: ReadonlyAnalystToolRequest }
  | { ok: false; reason: ToolDenialReason };

function isSelf(scope: AssistantScope, staff: string): boolean {
  const compact = staff.normalize("NFC").replace(/\s+/gu, "").toLowerCase();
  if (SELF_REFERENCES.has(compact)) return true;
  return scope.staffLabel !== null && normalizeStaffName(staff) === normalizeStaffName(scope.staffLabel);
}

/**
 * Decide one tool request. A staff requester's staff argument is replaced by
 * their own trusted label (or refused when it names someone else); a market
 * argument must be inside the scope. The data reader enforces the same owner
 * and market scope again at the source.
 */
export function authorizeToolRequest(
  scope: AssistantScope,
  request: ReadonlyAnalystToolRequest,
  allowedTools: ReadonlySet<ReadonlyAnalystToolName> = roleTools(scope),
): ToolAuthorization {
  if (!allowedTools.has(request.tool)) return { ok: false, reason: "tool_not_permitted" };

  if ("market" in request && typeof request.market === "string" && request.market.trim() && scope.markets !== null) {
    if (!scope.markets.has(canonicalMarketLabel(request.market))) return { ok: false, reason: "market_not_permitted" };
  }

  if (!("staff" in request)) return { ok: true, request };
  const staff = typeof request.staff === "string" ? request.staff.trim() : "";
  if (scope.role !== "staff") {
    if (staff && isSelf(scope, staff) && scope.staffLabel) {
      return { ok: true, request: { ...request, staff: scope.staffLabel } as ReadonlyAnalystToolRequest };
    }
    return { ok: true, request };
  }
  // staff role: own documents only. A missing filter means "mine".
  if (staff && !isSelf(scope, staff)) return { ok: false, reason: "other_staff" };
  return { ok: true, request: { ...request, staff: scope.staffLabel! } as ReadonlyAnalystToolRequest };
}

const ROLE_THAI: Record<AssistantScope["role"], string> = {
  supervisor: "หัวหน้างาน",
  staff: "พนักงานขาย",
  group_member: "สมาชิกกลุ่ม LINE ที่ได้รับอนุมัติ (ทุกคนในกลุ่มใช้สิทธิ์ของกลุ่มเดียวกัน)",
};

export function scopeInstructions(access: JobAccess): string[] {
  const { scope } = access;
  const lines = [
    `สิทธิ์ของผู้ถาม: ${ROLE_THAI[scope.role]}`,
    scope.markets === null ? "ดูได้ทุกตลาด" : `ดูได้เฉพาะตลาด: ${[...scope.markets].join(", ")}`,
  ];
  if (scope.role === "staff") {
    lines.push(
      `ผู้ถามคือ ${scope.staffLabel}; คำถามเรื่อง "ของผม/ของหนู/ของฉัน" ให้ใช้ชื่อ ${scope.staffLabel}`,
      "ผู้ถามดูได้เฉพาะเอกสารเบิก/คืน รายการค้าง และสลิปของตัวเองเท่านั้น ไม่เห็นยอดขาย สต๊อก ใบขาว หรือการปิดเงินของตลาด",
    );
  }
  if (access.audience === "group_policy") {
    lines.push("คำตอบนี้จะแสดงในกลุ่ม LINE ให้ทุกคนในกลุ่มเห็น");
  }
  return lines;
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
