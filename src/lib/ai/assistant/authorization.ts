/**
 * Per-user and per-market authorization for @Botsummary, enforced on the
 * server before any business query runs.
 *
 * Identity is the LINE user id from the signed webhook (stored on the job).
 * The question text and the model's tool arguments are never proof of who is
 * asking: "ของผม", a staff name or a market name only NARROW what the scope
 * already allows.
 *
 *   supervisor  env allowlist BOT_SUMMARY_ASSISTANT_SUPERVISOR_LINE_USER_IDS
 *               (all markets) or an active grant with role supervisor (its
 *               markets): every staff member inside those markets, settlement
 *               included.
 *   staff       active grant with role staff: only their own staff_label,
 *               only their markets, never settlement (approved Decision 1:
 *               settlement is for supervisors/admins only).
 *   no grant    nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { canonicalMarketLabel } from "@/lib/market";
import { compactToolOutput, ALL_ANALYST_TOOL_NAMES, type AnalystToolExecutor } from "@/lib/ai/readonly-analyst";
import {
  executeReadonlyAnalystTool,
  normalizeStaffName,
  type ReadonlyAnalystToolName,
  type ReadonlyAnalystToolRequest,
  type ToolDataScope,
} from "@/lib/ai/readonly-tools";

type Supabase = SupabaseClient<Database>;

export interface AssistantScope {
  lineUserId: string;
  role: "supervisor" | "staff";
  /** Trusted label for own-data questions; required for staff. */
  staffLabel: string | null;
  /** Canonical market labels; null = every market. */
  markets: ReadonlySet<string> | null;
  grantSource: "env_supervisor" | "grant";
}

export type ScopeResolution =
  | { ok: true; scope: AssistantScope }
  | { ok: false; reason: "no_user" | "no_grant" | "grant_lookup_failed" };

export const SUPERVISOR_ONLY_TOOLS: ReadonlySet<ReadonlyAnalystToolName> = new Set([
  "get_staff_settlement",
  "get_market_settlement",
  "get_settlement_overview",
]);

/** Words a requester uses for themself; resolved to their own trusted label. */
const SELF_REFERENCES = new Set(["ผม", "ฉัน", "หนู", "เรา", "ตัวเอง", "กู", "ข้า", "me", "myself"]);

export function parseSupervisorLineUserIds(
  value = process.env.BOT_SUMMARY_ASSISTANT_SUPERVISOR_LINE_USER_IDS,
): Set<string> {
  return new Set((value ?? "").split(/[,\s]+/u).map((part) => part.trim()).filter(Boolean));
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
  const markets = grant.all_markets
    ? null
    : new Set(grant.market_labels.map((label) => canonicalMarketLabel(label)).filter(Boolean));
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

export function allowedToolsFor(scope: AssistantScope): Set<ReadonlyAnalystToolName> {
  return new Set([...ALL_ANALYST_TOOL_NAMES].filter((tool) =>
    scope.role === "supervisor" || !SUPERVISOR_ONLY_TOOLS.has(tool)));
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
 * argument must be inside the scope. Data outside the scope is additionally
 * filtered at the source by the executor.
 */
export function authorizeToolRequest(
  scope: AssistantScope,
  request: ReadonlyAnalystToolRequest,
): ToolAuthorization {
  if (!allowedToolsFor(scope).has(request.tool)) return { ok: false, reason: "tool_not_permitted" };

  if ("market" in request && typeof request.market === "string" && request.market.trim() && scope.markets !== null) {
    if (!scope.markets.has(canonicalMarketLabel(request.market))) return { ok: false, reason: "market_not_permitted" };
  }

  if (!("staff" in request)) return { ok: true, request };
  const staff = typeof request.staff === "string" ? request.staff.trim() : "";
  if (scope.role === "supervisor") {
    if (staff && isSelf(scope, staff) && scope.staffLabel) {
      return { ok: true, request: { ...request, staff: scope.staffLabel } as ReadonlyAnalystToolRequest };
    }
    return { ok: true, request };
  }
  // staff role: own documents only. A missing filter means "mine".
  if (staff && !isSelf(scope, staff)) return { ok: false, reason: "other_staff" };
  return { ok: true, request: { ...request, staff: scope.staffLabel! } as ReadonlyAnalystToolRequest };
}

export function scopeInstructions(scope: AssistantScope): string[] {
  const lines = [
    `สิทธิ์ของผู้ถาม: ${scope.role === "supervisor" ? "หัวหน้างาน" : "พนักงานขาย"}`,
    scope.markets === null
      ? "ดูได้ทุกตลาด"
      : `ดูได้เฉพาะตลาด: ${[...scope.markets].join(", ")}`,
  ];
  if (scope.role === "staff") {
    lines.push(
      `ผู้ถามคือ ${scope.staffLabel}; คำถามเรื่อง "ของผม/ของหนู/ของฉัน" ให้ใช้ชื่อ ${scope.staffLabel}`,
      "ผู้ถามดูข้อมูลปิดเงิน (เงินขาด/เกิน) ไม่ได้ และดูเอกสารของพนักงานคนอื่นไม่ได้",
    );
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
  scope: AssistantScope,
  onDecision?: (tool: ReadonlyAnalystToolName, decision: "allowed" | ToolDenialReason) => void,
): AnalystToolExecutor {
  return async (request) => {
    const decision = authorizeToolRequest(scope, request);
    if (!decision.ok) {
      onDecision?.(request.tool, decision.reason);
      return { tool: request.tool, status: "forbidden", reason: decision.reason };
    }
    onDecision?.(request.tool, "allowed");
    return readData(decision.request, { markets: scope.markets });
  };
}
