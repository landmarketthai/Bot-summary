import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { FLEX_BUTTON_LABEL_MAX } from "@/lib/line/guided-menu/ux-types";
import { REPORT_CATEGORY_LABEL } from "@/lib/produce/product-code/category";

/**
 * Admin review of category candidates over LINE postbacks.
 *
 * Authorization is server-side and fail-closed: the postback must come from a
 * verified LINE user listed in CATEGORY_REVIEW_ADMIN_LINE_USER_IDS, inside a
 * group listed in CATEGORY_REVIEW_LINE_GROUP_IDS. Anything else is refused
 * without revealing candidate data. Idempotency (line event id), staleness
 * (status + revision) and the audit row live in decide_produce_category_candidate.
 */

export const CATEGORY_POSTBACK_PREFIX = "pcat1|";

export type ReviewCode = "ท" | "ม" | "ผ" | "ป" | "ห" | "พ";
const REVIEW_CODES: readonly ReviewCode[] = ["ม", "ผ", "ท", "ป", "ห", "พ"];

const ACTIONS = {
  as: "approve_suggested",
  sc: "select_category",
  al: "approve_alias",
  np: "new_product",
  rj: "reject",
  lo: "legitimate_other",
} as const;
type ActionKey = keyof typeof ACTIONS;

function idList(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? "").split(/[\s,]+/).map((id) => id.trim()).filter(Boolean));
}

/** No default: an unset variable means no group receives or approves anything. */
export function categoryReviewGroupIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return idList(env.CATEGORY_REVIEW_LINE_GROUP_IDS);
}

export function categoryReviewAdminIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return idList(env.CATEGORY_REVIEW_ADMIN_LINE_USER_IDS);
}

export interface CategoryCandidate {
  id: string;
  product_name: string;
  suggested_category: ReviewCode | null;
  confidence: "high" | "medium" | "low";
  suggestion_reason: string;
  similar_product_name: string | null;
  occurrence_count: number;
  distinct_dates: number;
  first_seen: string | null;
  last_seen: string | null;
  sample_markets: string[];
  revision: number;
}

const CONFIDENCE_LABEL = { high: "สูง", medium: "กลาง", low: "ต่ำ" } as const;

function postback(candidate: CategoryCandidate, action: ActionKey, code = ""): string {
  return `${CATEGORY_POSTBACK_PREFIX}${candidate.id}|${candidate.revision}|${action}|${code}`;
}

function button(label: string, data: string, style: "primary" | "secondary" = "secondary") {
  // LINE counts code points; never split a surrogate pair.
  const safe = [...label].slice(0, FLEX_BUTTON_LABEL_MAX).join("");
  return { type: "button", style, height: "sm", margin: "sm", action: { type: "postback", label: safe, data } };
}

/** Flex card for the review group. `aliasCode` = category of the similar name. */
export function buildCategoryReviewMessage(
  candidate: CategoryCandidate,
  aliasCode: ReviewCode | null,
): Record<string, unknown> {
  const suggested = candidate.suggested_category;
  const lines = [
    `ข้อเสนอ: ${suggested ? REPORT_CATEGORY_LABEL[suggested] : "ไม่มี"} (ความมั่นใจ${CONFIDENCE_LABEL[candidate.confidence]})`,
    `เหตุผล: ${candidate.suggestion_reason}`,
    `พบ ${candidate.occurrence_count} รายการ ใน ${candidate.distinct_dates} วัน (${candidate.first_seen ?? "-"} ถึง ${candidate.last_seen ?? "-"})`,
    ...(candidate.sample_markets.length ? [`ตลาด: ${candidate.sample_markets.join(", ")}`] : []),
  ];
  const buttons = [
    ...(suggested ? [button(`✅ อนุมัติ: ${REPORT_CATEGORY_LABEL[suggested]}`, postback(candidate, "as"), "primary")] : []),
    ...REVIEW_CODES.filter((code) => code !== suggested)
      .map((code) => button(`เลือก: ${REPORT_CATEGORY_LABEL[code]}`, postback(candidate, "sc", code))),
    ...(candidate.similar_product_name && aliasCode
      ? [button(`🔗 หมวดเดียวกับ ${candidate.similar_product_name}`, postback(candidate, "al"))] : []),
    ...(suggested ? [button(`🆕 สินค้าใหม่ (${REPORT_CATEGORY_LABEL[suggested]})`, postback(candidate, "np", suggested))] : []),
    button("📦 เป็นสินค้าอื่นๆ จริง", postback(candidate, "lo")),
    button("🚫 ปฏิเสธข้อเสนอ", postback(candidate, "rj")),
  ];
  return {
    type: "flex",
    altText: `ตรวจหมวดสินค้า: ${candidate.product_name}`.slice(0, 400),
    contents: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", spacing: "sm",
        contents: [
          { type: "text", text: "🔎 สินค้าที่ยังอยู่ในหมวดอื่นๆ", size: "sm", color: "#888888" },
          { type: "text", text: candidate.product_name, weight: "bold", size: "lg", wrap: true },
          ...lines.map((text) => ({ type: "text", text, size: "sm", wrap: true })),
          { type: "text", text: "เปลี่ยนเฉพาะหมวดในรายงาน ไม่แก้ชื่อสินค้า ยอดเงิน หรือจำนวน", size: "xs", color: "#888888", wrap: true },
        ],
      },
      footer: { type: "box", layout: "vertical", contents: buttons },
    },
  };
}

export interface ParsedCategoryPostback {
  candidateId: string;
  revision: number;
  action: (typeof ACTIONS)[ActionKey];
  code: ReviewCode | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCategoryReviewPostback(data: string): boolean {
  return data.startsWith(CATEGORY_POSTBACK_PREFIX);
}

export function parseCategoryReviewPostback(data: string): ParsedCategoryPostback | null {
  const [, id, revision, action, code] = data.split("|");
  if (!id || !UUID.test(id) || !/^\d{1,9}$/.test(revision ?? "") || !(action! in ACTIONS)) return null;
  const needsCode = action === "sc" || action === "np";
  if (needsCode !== REVIEW_CODES.includes(code as ReviewCode)) return null;
  return { candidateId: id, revision: Number(revision), action: ACTIONS[action as ActionKey], code: needsCode ? code as ReviewCode : null };
}

export interface CategoryReviewInput {
  data: string;
  lineEventId: string;
  userId: string | null;
  sourceType: string;
  sourceId: string;
}

export interface CategoryReviewDeps {
  supabase: SupabaseClient;
  /**
   * Category the current policy gives the similar (alias) name. Called only
   * after authorization, so unauthorized taps never read the rule table.
   */
  aliasCodeFor: (name: string) => ReviewCode | null | Promise<ReviewCode | null>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Returns the reply text, or null when nothing may be said (wrong group).
 */
export async function handleCategoryReviewPostback(
  input: CategoryReviewInput,
  deps: CategoryReviewDeps,
): Promise<string | null> {
  const env = deps.env ?? process.env;
  // Outside the review group(s): silent, so no candidate data or feature
  // existence leaks into operational groups.
  if (input.sourceType !== "group" || !categoryReviewGroupIds(env).has(input.sourceId)) return null;
  if (!input.userId || !categoryReviewAdminIds(env).has(input.userId)) {
    logger.warn("category review postback refused — not an admin", { sourceId: input.sourceId });
    return "⛔ ไม่มีสิทธิ์อนุมัติหมวดสินค้า";
  }
  const parsed = parseCategoryReviewPostback(input.data);
  if (!parsed) return "❌ ปุ่มไม่ถูกต้อง";

  let category: string | null = parsed.code;
  let aliasTarget: string | null = null;
  if (parsed.action === "approve_alias") {
    const { data, error } = await deps.supabase
      .from("produce_category_candidates")
      .select("similar_product_name")
      .eq("id", parsed.candidateId)
      .maybeSingle();
    if (error) return "❌ บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง";
    aliasTarget = (data as { similar_product_name: string | null } | null)?.similar_product_name ?? null;
    category = aliasTarget ? await deps.aliasCodeFor(aliasTarget) : null;
    if (!aliasTarget || !category) return "⚠️ ไม่พบหมวดของชื่อที่ใกล้เคียง กรุณาเลือกหมวดเอง";
  }

  const { data, error } = await deps.supabase.rpc("decide_produce_category_candidate", {
    p_candidate_id: parsed.candidateId,
    p_revision: parsed.revision,
    p_action: parsed.action,
    p_category_code: category,
    p_alias_target: aliasTarget,
    p_line_user_id: input.userId,
    p_source_id: input.sourceId,
    p_line_event_id: input.lineEventId,
  });
  if (error) {
    logger.error("category review decision failed", { error: error.message });
    return "❌ บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง";
  }
  const result = data as { status: string; product_name?: string; category_code?: string | null };
  switch (result.status) {
    case "applied": {
      const label = result.category_code === "other" ? "อื่นๆ (ยืนยันแล้ว)"
        : result.category_code ? REPORT_CATEGORY_LABEL[result.category_code as ReviewCode] : "ปฏิเสธข้อเสนอ";
      return `✅ บันทึกแล้ว: ${result.product_name} → ${label}\nมีผลกับรายงานรอบถัดไป`;
    }
    case "duplicate": return "ℹ️ คำสั่งนี้บันทึกไปแล้ว";
    case "stale": return "⚠️ การ์ดนี้หมดอายุ (มีการตัดสินใจหรือข้อเสนอใหม่แล้ว)";
    default: return "❌ ไม่สามารถบันทึกรายการนี้ได้";
  }
}
