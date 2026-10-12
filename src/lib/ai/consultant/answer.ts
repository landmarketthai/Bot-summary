/**
 * @Botsummary entry point for LINE questions: the existing read-only analyst,
 * extended with the AI Consultant (usage guide, own-submission status,
 * diagnosis) when BOT_SUMMARY_CONSULTANT_ENABLED=true.
 *
 *   LINE question
 *   → authorization (scope from the signed event, before any read)
 *   → GPT picks read-only tools (knowledge / workflow / analyst)
 *   → deterministic evidence (facts, state, allowed next actions, Thai reply)
 *   → GPT phrases it; a deterministic guard rejects unsupported claims
 *   → deterministic fallback when the model fails or times out.
 *
 * Nothing here writes business data.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { BOT_SUMMARY_USAGE_REPLY } from "@/lib/ai/line-command";
import type { OpenAIAnalystOptions } from "@/lib/ai/openai-analyst";
import {
  answerWithReadonlyTools,
  resolveAnalystBusinessDate,
  type AnalystToolExtension,
} from "@/lib/ai/readonly-analyst";
import {
  isBotSummaryConsultantEnabled,
  resolveConsultantScope,
  type ScopeResolutionOptions,
} from "./authorization";
import { loadRecentBotSummaryQuestions } from "./conversation";
import { safeLabel } from "./diagnostics";
import {
  CONSULTANT_ACTION_GUIDES,
  CONSULTANT_KNOWLEDGE,
  CONSULTANT_KNOWLEDGE_VERSION,
  findKnowledge,
  getKnowledge,
} from "./knowledge";
import type { ConsultantActionId, ConsultantScope } from "./types";
import {
  getLatestSubmissionStatus,
  getPendingSubmissions,
  getSubmissionDiagnosis,
  type SubmissionCandidate,
  type SubmissionEvidence,
} from "./workflow-status";

export { isBotSummaryConsultantEnabled };

type Supabase = SupabaseClient<Database>;

/** Facts about the asker, taken from the signed LINE event by the webhook. */
export interface BotSummaryQuestionContext {
  sourceId: string;
  sourceType: "group" | "room" | "user";
  lineUserId: string | null;
  destination: string;
  rawMessageId: string;
  /** False in consultant-only (worker) chats: no sales/settlement tools. */
  analystToolsAllowed?: boolean;
}

export interface ConsultantAnswerDependencies {
  consultantEnabled: boolean;
  openai?: OpenAIAnalystOptions;
  scopeOptions?: ScopeResolutionOptions;
  now?: () => number;
  /** Total model budget per question, ms. */
  budgetMs?: number;
}

// The answer runs inside the per-chat ordered LINE queue; keep it short so a
// question never holds that chat's produce messages for long.
const DEFAULT_BUDGET_MS = 15_000;
const PER_CALL_TIMEOUT_MS = 8_000;

const CONSULTANT_USAGE_LINES = [
  "• @Botsummary ชั่งคืนต้องพิมพ์ยังไง",
  "• @Botsummary เมื่อกี้รายการผมเข้าหรือยัง",
  "• @Botsummary ทำไมข้อ 22 ไม่ผ่าน",
];

/** consultantOnly: worker chats, where sales/settlement questions are not offered. */
export function botSummaryUsageReply(consultantEnabled: boolean, consultantOnly = false): string {
  if (!consultantEnabled) return BOT_SUMMARY_USAGE_REPLY;
  if (consultantOnly) {
    return ["ถาม @Botsummary ได้ เช่น", ...CONSULTANT_USAGE_LINES, "• @Botsummary วันนี้มีอะไรค้าง"].join("\n");
  }
  return [BOT_SUMMARY_USAGE_REPLY, ...CONSULTANT_USAGE_LINES].join("\n");
}

// ── Thai fixed replies ───────────────────────────────────────────────────────

const REPLY_FORBIDDEN =
  "ดูสถานะได้เฉพาะรายการที่คุณส่งเองครับ ถ้าต้องการดูรายการของคนอื่น กรุณาสอบถามผู้ดูแลครับ";
const REPLY_UNAVAILABLE =
  "ตอนนี้ตรวจสถานะรายการจากระบบไม่ได้ชั่วคราวครับ ยังยืนยันไม่ได้ว่าบันทึกแล้วหรือยัง กรุณาลองถามใหม่อีกครั้งครับ";
const REPLY_IDENTITY_UNVERIFIED =
  "ยังยืนยันตัวผู้ถามไม่ได้ จึงดูสถานะรายการให้ไม่ได้ครับ กรุณาถามจากบัญชีไลน์ที่ใช้ส่งรายการครับ";
const REPLY_NONE =
  "ไม่พบรายการผักที่ตรงกับคำถามในช่วง 3 วันนี้ครับ ถ้าเพิ่งส่ง กรุณาดูข้อความตอบกลับของบอทหรือถามใหม่อีกครั้งครับ";
const REPLY_FINANCE_UNVERIFIED =
  "ตอนนี้ยังยืนยันเรื่องยอดเงินหรือสลิปจากระบบไม่ได้ครับ กรุณาสอบถามผู้ดูแลครับ";
const REPLY_CANNOT_CONFIRM =
  "ยังยืนยันจากระบบไม่ได้ว่ารายการบันทึกแล้วหรือยังครับ กรุณาถามสถานะอีกครั้ง เช่น “รายการชั่งคืนล่าสุดของผมเข้าหรือยัง” ครับ";

function candidateLine(candidate: SubmissionCandidate): string {
  return [
    candidate.transactionKindThai,
    safeLabel(candidate.staff),
    safeLabel(candidate.market),
    candidate.businessDate,
  ]
    .filter(Boolean)
    .join(" ");
}

function ambiguousReply(candidates: SubmissionCandidate[]): string {
  const options = candidates.slice(0, 3).map((candidate) => `• ${candidateLine(candidate)}`);
  return ["มีมากกว่าหนึ่งรายการครับ หมายถึงรายการไหนครับ", ...options].join("\n");
}

// ── Tool outputs (compact, worker-safe) ─────────────────────────────────────

type ToolOutput = Record<string, unknown> & { suggestedReply?: string };

function evidenceForModel(evidence: SubmissionEvidence): Record<string, unknown> {
  return {
    businessDate: evidence.businessDate,
    staff: safeLabel(evidence.staff),
    market: safeLabel(evidence.market),
    transactionKindThai: evidence.transactionKindThai,
    state: evidence.state,
    persisted: evidence.persisted,
    savedItemCount: evidence.savedItemCount,
    acceptedButNotSavedCount: evidence.acceptedUnsavedCount,
    needsReviewCount: evidence.needsReviewCount,
    blockers: evidence.blockers.slice(0, 5).map((blocker) => ({
      itemNumber: blocker.itemNumber,
      productName: safeLabel(blocker.productName),
      problemThai: blocker.kindThai,
      detailThai: blocker.detailThai,
    })),
    allowedNextActions: evidence.allowedActions.map((action) => ({
      action,
      howToThai: CONSULTANT_ACTION_GUIDES[action].howToThai,
    })),
    canCorrectInPlace: evidence.canCorrectInPlace,
  };
}

type WorkflowResult =
  | Awaited<ReturnType<typeof getLatestSubmissionStatus>>
  | Awaited<ReturnType<typeof getSubmissionDiagnosis>>;

function workflowOutput(result: WorkflowResult): ToolOutput {
  switch (result.status) {
    case "ok": {
      const requestedItem = "requestedItem" in result ? result.requestedItem : undefined;
      return {
        status: "ok",
        submission: evidenceForModel(result.submission),
        ...(requestedItem ? { requestedItem } : {}),
        suggestedReply: result.submission.workerMessage,
      };
    }
    case "none":
      return { status: "none", suggestedReply: REPLY_NONE };
    case "ambiguous":
      return {
        status: "ambiguous",
        candidates: result.candidates.slice(0, 3).map(candidateLine),
        suggestedReply: ambiguousReply(result.candidates),
      };
    case "forbidden":
      return { status: "forbidden", suggestedReply: REPLY_FORBIDDEN };
    case "invalid_request":
      return { status: "invalid_request", field: result.field };
    default:
      return { status: "unavailable", suggestedReply: REPLY_UNAVAILABLE };
  }
}

function pendingOutput(result: Awaited<ReturnType<typeof getPendingSubmissions>>): ToolOutput {
  if (result.status === "forbidden") return { status: "forbidden", suggestedReply: REPLY_FORBIDDEN };
  if (result.status !== "ok") return { status: "unavailable", suggestedReply: REPLY_UNAVAILABLE };
  const shown = result.submissions.slice(0, 5);
  const suggestedReply = shown.length === 0
    ? "ตอนนี้ไม่มีรายการของคุณที่ค้างอยู่ในช่วง 3 วันนี้ครับ"
    : shown.length === 1
      ? shown[0]!.workerMessage
      : [
          `มีรายการที่ยังไม่จบ ${result.submissions.length} รายการครับ`,
          ...shown.map((evidence) => `• ${evidence.workerMessage}`),
        ].join("\n");
  return {
    status: "ok",
    count: result.submissions.length,
    truncated: result.truncated,
    submissions: shown.map(evidenceForModel),
    suggestedReply,
  };
}

// ── Tool definitions ────────────────────────────────────────────────────────

const TOPIC_IDS = CONSULTANT_KNOWLEDGE.map((entry) => entry.id);
const KIND_ENUM = ["any", "withdrawal", "return", "damaged_return"] as const;

const STAFF_PARAM = {
  type: "string",
  description: "ชื่อคนขายที่ผู้ใช้ระบุ เช่น น้อย ถ้าผู้ใช้ถามรายการของตัวเอง (ของผม ของฉัน) หรือไม่ได้ระบุชื่อ ให้ส่งค่าว่าง \"\"",
};

const KNOWLEDGE_TOOL = {
  type: "function",
  name: "get_usage_guide",
  description: "วิธีใช้ Bot Summary ที่ยืนยันจากระบบจริง เช่น เบิก ชั่งคืน คืนเสีย แก้ข้อ ลบข้อ จบรายการ สลิป ใบขาว และการแจ้งผู้ดูแล",
  parameters: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: TOPIC_IDS,
        description: CONSULTANT_KNOWLEDGE.map((entry) => `${entry.id}=${entry.titleThai}`).join("; "),
      },
    },
    required: ["topic"],
    additionalProperties: false,
  },
  strict: true,
} as const;

const MARKET_PARAM = {
  type: "string",
  description: "ชื่อตลาดถ้าผู้ใช้ระบุ ไม่ระบุให้ส่งค่าว่าง",
};

const WORKFLOW_TOOLS = [
  {
    type: "function",
    name: "get_submission_status",
    description: "สถานะจริงของรายการผัก (เบิก/ชั่งคืน/คืนเสีย) ล่าสุดที่ส่ง ว่าบันทึกแล้ว รอตรวจ หรือยังไม่บันทึก",
    parameters: {
      type: "object",
      properties: {
        staff: STAFF_PARAM,
        market: MARKET_PARAM,
        transaction_kind: { type: "string", enum: KIND_ENUM, description: "any=ไม่ระบุ" },
      },
      required: ["staff", "transaction_kind", "market"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_unfinished_submissions",
    description: "รายการผักที่ยังไม่จบ ยังไม่บันทึก หรือติดปัญหาอยู่",
    parameters: {
      type: "object",
      properties: { staff: STAFF_PARAM, market: MARKET_PARAM },
      required: ["staff", "market"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_submission_problem",
    description: "ข้อไหนไม่ผ่าน เพราะอะไร และต้องทำอะไรต่อ สำหรับรายการผักล่าสุดหรือรายการที่มีข้อที่ระบุ",
    parameters: {
      type: "object",
      properties: {
        staff: STAFF_PARAM,
        market: MARKET_PARAM,
        item_number: { type: "integer", description: "เลขข้อที่ผู้ใช้ถาม ถ้าไม่ระบุให้ใส่ 0" },
      },
      required: ["staff", "item_number", "market"],
      additionalProperties: false,
    },
    strict: true,
  },
] as const;

const CONSULTANT_INSTRUCTIONS = [
  "คุณเป็นผู้ช่วยให้คำปรึกษาพนักงานหน้างานที่ใช้ Bot Summary ด้วย",
  "คำถามวิธีใช้งาน ให้เรียก get_usage_guide แล้วตอบตามข้อมูลนั้นเท่านั้น ห้ามแต่งคำสั่งหรือขั้นตอนที่ไม่มีใน tool",
  "คำถามว่ารายการเข้าหรือยัง สำเร็จไหม ค้างอะไร ข้อไหนผิด ต้องแก้อะไร ต้องส่งใหม่ไหม ให้เรียก tool สถานะรายการทุกครั้ง แม้เคยถามมาก่อน",
  "ถ้าผู้ใช้ถามรายการของตัวเองหรือไม่ระบุชื่อ ให้ส่ง staff เป็นค่าว่าง ใส่ชื่อเฉพาะเมื่อผู้ใช้ระบุชื่อคนขาย",
  "ถ้าผู้ใช้ตอบชื่อตลาดหลังถูกถามกลับ ให้เรียก tool เดิมพร้อม market และ staff จากคำถามก่อนหน้า ห้ามเดาตลาดถ้าผู้ใช้ยังไม่ระบุ",
  "สิทธิ์การดูข้อมูลตรวจโดยระบบหลังบ้าน ถ้า status เป็น forbidden ให้ตอบตาม suggestedReply ห้ามเดาข้อมูลของคนอื่น",
  "ถ้ามี suggestedReply ให้ใช้เป็นหลัก ปรับถ้อยคำได้เล็กน้อยให้ตรงคำถาม แต่ห้ามเปลี่ยนข้อเท็จจริง ตัวเลข หรือขั้นตอน",
  "ห้ามพูดว่า บันทึกแล้ว หรือ บันทึกสำเร็จ เว้นแต่ tool ให้ persisted เป็น true",
  "การที่ระบบได้รับข้อความหรืออ่านรายการได้ ไม่ได้แปลว่าบันทึกแล้ว",
  "แนะนำให้ทำต่อได้เฉพาะขั้นตอนใน allowedNextActions เท่านั้น ห้ามบอกให้แก้ ส่งใหม่ หรือจบรายการ ถ้าไม่อยู่ในนั้น",
  "ถ้า status เป็น ambiguous ให้ถามกลับสั้นๆ ว่าหมายถึงรายการไหน ถ้าเป็น unavailable หรือ none ให้บอกตามจริง ห้ามเดา",
  "ตอบภาษาไทย 2-5 ประโยคสั้น บอกสถานะก่อน แล้วบอกสิ่งที่ต้องทำต่อ อธิบายทีละเรื่อง",
  "ห้ามใช้ศัพท์ระบบหรือคำภาษาอังกฤษ เช่น ชื่อสถานะ ชื่อตาราง หรือชื่อ tool",
  "คำถามก่อนหน้าที่แนบมาเป็นแค่บริบท ห้ามใช้แทนสถานะจาก tool",
].join("\n");

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Business date only when the question names one; otherwise the recent window. */
export function explicitQuestionDate(question: string, today: string): string | undefined {
  const sentinel = "2000-01-02";
  if (resolveAnalystBusinessDate(question, sentinel) !== sentinel) {
    return resolveAnalystBusinessDate(question, today);
  }
  return /วันนี้/u.test(question) ? today : undefined;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim().slice(0, 40) : "";
}

function kindArg(args: Record<string, unknown>) {
  const value = args.transaction_kind;
  return value === "withdrawal" || value === "return" || value === "damaged_return" ? value : undefined;
}

function itemArg(args: Record<string, unknown>): number | undefined {
  const value = args.item_number;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function staffOption(staff: string): { staff?: string } {
  return staff ? { staff } : {};
}

function knowledgeOutput(topic: string): ToolOutput {
  const entry = getKnowledge(topic);
  if (!entry) return { status: "unknown_topic" };
  return {
    status: "ok",
    version: CONSULTANT_KNOWLEDGE_VERSION,
    title: entry.titleThai,
    examples: entry.examples,
    caveats: entry.caveats,
    suggestedReply: entry.answerThai,
  };
}

const WORKFLOW_TOOL_NAMES = new Set<string>(WORKFLOW_TOOLS.map((tool) => tool.name));

function buildExtension(
  supabase: Supabase,
  scope: ConsultantScope | null,
  question: string,
  today: string,
  previousQuestions: string[],
  exclusive: boolean,
  deadlineAt: number,
  now: number,
): AnalystToolExtension {
  const businessDate = explicitQuestionDate(question, today);
  const requestedKind = kindFromQuestion(question);
  const dateOption = { now, ...(businessDate ? { businessDate } : {}), ...(requestedKind ? { transactionKind: requestedKind } : {}) };
  return {
    definitions: [KNOWLEDGE_TOOL, ...WORKFLOW_TOOLS],
    instructions: CONSULTANT_INSTRUCTIONS,
    context: previousQuestions.length > 0
      ? `[คำถามก่อนหน้าของผู้ใช้คนเดียวกัน (บริบทเท่านั้น)]\n${previousQuestions.map((text) => `- ${text}`).join("\n")}`
      : undefined,
    exclusive,
    deadlineAt,
    execute(name, args) {
      if (name === "get_usage_guide") {
        return Promise.resolve(knowledgeOutput(stringArg(args, "topic")));
      }
      if (!WORKFLOW_TOOL_NAMES.has(name)) return null;
      // Authorization was resolved from the LINE event before the model ran.
      // Model arguments only narrow the request; they never widen the scope.
      if (!scope) return Promise.resolve({ status: "identity_unverified", suggestedReply: REPLY_IDENTITY_UNVERIFIED });
      const market = stringArg(args, "market");
      const staff = { ...staffOption(stringArg(args, "staff")), ...(market ? { market } : {}) };
      switch (name) {
        case "get_submission_status": {
          const kind = requestedKind ?? kindArg(args);
          return getLatestSubmissionStatus(supabase, scope, {
            ...staff, ...dateOption, ...(kind ? { transactionKind: kind } : {}),
          }).then(workflowOutput);
        }
        case "get_unfinished_submissions":
          return getPendingSubmissions(supabase, scope, { ...staff, ...dateOption }).then(pendingOutput);
        default: {
          const itemNumber = itemArg(args);
          return getSubmissionDiagnosis(supabase, scope, {
            ...staff, ...dateOption, ...(itemNumber ? { itemNumber } : {}),
          }).then(workflowOutput);
        }
      }
    },
  };
}

// ── Deterministic guard + fallback ──────────────────────────────────────────

const SAVED_CLAIM = /(?:บันทึก|เซฟ|เข้าระบบ|รายการเข้า|ส่งเข้า)(?:(?!ไม่|ยัง).){0,8}?(?:แล้ว|เรียบร้อย|สำเร็จ|ครบ)|สำเร็จแล้ว|เรียบร้อยแล้ว/gu;

const INTERNAL_TERMS =
  /failed_closed|terminaliz|partial_capture|pending_session|finaliz|accountability|session_key|\bnull\b|undefined/iu;

function compactThai(text: string): string {
  return text.normalize("NFC").replace(/[\s\u200b-\u200d\ufeff]+/gu, "");
}

/**
 * Does the text assert that something was saved? Deliberately broad: a false
 * positive only swaps the model's wording for the deterministic reply, while a
 * false negative tells a worker their goods were recorded when they were not.
 * `allowQuoted` keeps how-to answers that quote the bot's own “บันทึกแล้ว”.
 */
export function claimsSaved(text: string, allowQuoted = false): boolean {
  const compact = compactThai(text);
  for (const match of compact.matchAll(SAVED_CLAIM)) {
    const before = compact.slice(Math.max(0, match.index - 6), match.index);
    if (/(?:ยัง|ไม่|ไม่ได้)$/u.test(before)) continue;
    if (allowQuoted && /[“"']$/u.test(before)) continue;
    return true;
  }
  return false;
}

const SLIP_CLAIM = /ตรวจ(?:สอบ)?สลิป(?:แล้ว|เรียบร้อย)/gu;
const AMOUNT_CLAIM =
  /ยอด(?:เงิน)?(?:ถูกต้อง|ตรง)|ปิดเงิน(?:เรียบร้อย|แล้ว|สำเร็จ)|ส่งเงินครบ|เงินครบแล้ว|ไม่มียอดขาด|ไม่ขาดไม่เกิน/gu;

export function claimsSlipVerified(text: string): boolean {
  return hasAffirmedMatch(compactThai(text), SLIP_CLAIM);
}

function hasAffirmedMatch(compact: string, pattern: RegExp): boolean {
  for (const match of compact.matchAll(pattern)) {
    if (/(?:ยัง|ไม่|ไม่ได้)$/u.test(compact.slice(Math.max(0, match.index - 6), match.index))) continue;
    return true;
  }
  return false;
}

/** Does the text assert that a slip / amount / settlement was verified? A negated mention is not a claim. */
export function claimsFinanceVerified(text: string): boolean {
  const compact = compactThai(text);
  return hasAffirmedMatch(compact, SLIP_CLAIM) || hasAffirmedMatch(compact, AMOUNT_CLAIM);
}

const SETTLEMENT_TOOL_NAMES = new Set(["get_staff_settlement", "get_market_settlement", "get_settlement_overview"]);
// One business date is proven per tool call; a claim about a range is not.
const PERIOD_RANGE = /สัปดาห์|อาทิตย์|เดือน|ย้อนหลัง|ตั้งแต่|ทั้งหมด|ทุกวัน|\d\s*วัน/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One settlement row proves a match only when every input is present, nothing is uncertain, and cash equals the formula. */
function isMatchedSettlement(row: unknown): boolean {
  return isRecord(row)
    && row.status === "CLOSED_MATCHED"
    && Array.isArray(row.missingInputs) && row.missingInputs.length === 0
    && Array.isArray(row.uncertainty) && row.uncertainty.length === 0
    && row.cashDifferenceBaht === 0
    && typeof row.expectedCashBaht === "number" && typeof row.actualCashBaht === "number";
}

/** The tool was asked about the staff/market the question names (it is model-chosen, so never trusted blindly). */
function settlementTargetNamedInQuestion(output: Record<string, unknown>, compactQuestion: string): boolean {
  if (output.tool === "get_settlement_overview") return true;
  const target = output.tool === "get_staff_settlement" ? output.requestedStaff : output.requestedMarket;
  const name = typeof target === "string" ? compactThai(target) : "";
  return name.length > 0 && compactQuestion.includes(name);
}

/**
 * Deterministic finance proof from the analyst's REAL tool results. An attempted
 * call is not evidence: every settlement call must have succeeded (no `error`),
 * covered the question's business date and target, found rows, and returned only
 * fully-matched settlements with no missing inputs and no uncertainty notes.
 * Any failed, empty, incomplete, differing or unrelated result fails closed.
 */
export function hasAuthoritativeSettlementProof(
  analystOutputs: Array<{ tool: string; output: Record<string, unknown> }>,
  question: string,
  businessDate: string,
): boolean {
  const compactQuestion = compactThai(question);
  if (PERIOD_RANGE.test(compactQuestion)) return false;
  const finance = analystOutputs.filter((entry) => SETTLEMENT_TOOL_NAMES.has(entry.tool));
  if (finance.length === 0) return false;
  return finance.every(({ tool, output }) => {
    if ("error" in output || output.tool !== tool || output.businessDate !== businessDate) return false;
    if (output.found === false) return false;
    if (tool === "get_staff_settlement"
      && !(typeof output.matchedProduceRows === "number" && output.matchedProduceRows > 0
        && output.unresolvedSourceRows === 0)) return false;
    const settlements = output.settlements;
    if (!Array.isArray(settlements) || settlements.length === 0) return false;
    if (tool === "get_settlement_overview" && output.settlementCount !== settlements.length) return false;
    return settlementTargetNamedInQuestion(output, compactQuestion) && settlements.every(isMatchedSettlement);
  });
}

/** Only complete verified text can explain persistence without live workflow proof. */
export function claimsUngroundedSaved(answer: string, groundingTexts: string[]): boolean {
  return claimsSaved(answer)
    && !groundingTexts.some((text) => compactThai(text) === compactThai(answer));
}

/**
 * Replace a model answer that contradicts the evidence with the deterministic
 * reply. A saved claim is accepted only when the LAST status evidence the
 * model saw proves persistence for that document.
 */
export function guardConsultantAnswer(
  answer: string,
  workflowOutputs: ToolOutput[],
): string {
  if (workflowOutputs.length === 0) return answer;
  const last = workflowOutputs.at(-1)!;
  const fallback = last.suggestedReply ?? REPLY_CANNOT_CONFIRM;
  if (INTERNAL_TERMS.test(answer)) return fallback;
  const provenSaved = (last.submission as { persisted?: unknown } | undefined)?.persisted === true;
  if (!provenSaved && claimsSaved(answer)) return fallback;
  if (suggestsUnsupportedAction(answer, workflowOutputs)) return fallback;
  return answer;
}

// Worker instructions the model might add, and the action each one requires.
const ACTION_PHRASES: Array<[RegExp, ConsultantActionId]> = [
  [/แก้ข้อ/u, "correct_item_in_open_draft"],
  [/ลบข้อ/u, "remove_item_in_open_draft"],
  [/ยืนยันข้อ|ยืนยันจบรายการ/u, "confirm_review"],
  [/พิมพ์(?:คำสั่ง)?จบรายการ|ส่ง(?:คำสั่ง)?จบรายการ(?:อีก|ใหม่)/u, "send_close_again"],
  [/ส่ง(?:รายการ)?ใหม่ทั้งหมด|พิมพ์ใหม่ทั้งหมด|เริ่มรายการใหม่/u, "start_new_document"],
];

/** True when the answer tells the worker to do something the evidence does not allow. */
function suggestsUnsupportedAction(answer: string, workflowOutputs: ToolOutput[]): boolean {
  const last = workflowOutputs.at(-1)!;
  const documents = [
    last.submission,
    ...((last.submissions as unknown[] | undefined) ?? []),
  ] as Array<{ allowedNextActions?: Array<{ action: string }> } | undefined>;
  const allowed = new Set(documents.flatMap((doc) => doc?.allowedNextActions?.map((entry) => entry.action) ?? []));
  const compact = compactThai(answer);
  return ACTION_PHRASES.some(([phrase, action]) => phrase.test(compact) && !allowed.has(action));
}

const STATUS_QUESTION =
  /เข้า(?:หรือ)?ยัง|เข้าไหม|เข้ามั้ย|สำเร็จ(?:ไหม|มั้ย|หรือยัง)|บันทึก(?:แล้ว)?(?:หรือยัง|ไหม|มั้ย)|รายการ.{0,12}เป็น(?:ยัง|อย่าง)?ไง|ไม่ขึ้น|ยังไม่เข้า|ติดอะไร/u;
const PENDING_QUESTION = /ค้าง|ยังไม่จบ|ยังไม่เสร็จ/u;
const PROBLEM_QUESTION = /ทำไม|ไม่ผ่าน|ต้องแก้|แก้อะไร|ข้อไหน|ผิด|ส่งใหม่|ต่อยังไง|ยังไงต่อ|ทำอะไรต่อ/u;
// Intent comes from the question, never from whichever tool the model chose.
const USAGE_QUESTION = /วิธี|หมายถึง|แปลว่า|คืออะไร|(?:พิมพ์|ใช้งาน|ใช้|ส่ง|ทำ|แก้|กู้|ลบ).{0,30}(?:ยังไง|อย่างไร)(?!ต่อ)/u;
const DOCUMENT_CONTEXT = /รายการ|เอกสาร|เบิก|ชั่งคืน|คืนเสีย|ข้อ\s*\d/u;
const FIRST_PERSON = /ผม|ฉัน|หนู|ของเรา|ของตัวเอง|เมื่อกี้/u;

const ANALYST_CONTEXT = /ยอดขาย|สต็อก|ของเหลือ|คงเหลือ|เงินขาด|เงินเกิน|ปิดเงิน|ยอดส่ง|ยอดรับ|ใบขาว|สลิป/u;

/** Domain and live-state intent are resolved before trusting any selected tool. */
function questionIntent(question: string): "workflow" | "guide" | "analyst" {
  const compact = compactThai(question);
  if (/^(?:ถ้า|หาก|สมมติ)/u.test(compact)) return "guide";
  const specificDocument = /เมื่อกี้|ข้อ\d|(?:รายการ|เอกสาร)(?:ของ)?(?:ผม|ฉัน|หนู)/u.test(compact);
  if (USAGE_QUESTION.test(compact) && !specificDocument) return "guide";
  const stateQuestion = STATUS_QUESTION.test(compact) || PENDING_QUESTION.test(compact)
    || (/ล่าสุด/u.test(compact) && DOCUMENT_CONTEXT.test(compact));
  const topics = findKnowledge(compact);
  if (!stateQuestion && !PROBLEM_QUESTION.test(compact)
    && topics.some((entry) => entry.keywords.some((keyword) => compactThai(keyword) === compact))) return "guide";
  const liveDocument = STATUS_QUESTION.test(compact) && DOCUMENT_CONTEXT.test(compact);
  if (ANALYST_CONTEXT.test(compact) && !liveDocument) return "analyst";
  if (stateQuestion) return "workflow";
  if (PROBLEM_QUESTION.test(compact) && (FIRST_PERSON.test(compact) || /ข้อ\d/u.test(compact))) return "workflow";
  if (topics.length > 0) return "guide";
  return PROBLEM_QUESTION.test(compact) ? "workflow" : "analyst";
}

export function isStatusQuestion(question: string): boolean {
  return questionIntent(question) === "workflow";
}

/** Unspecified documents default to own scope; management-wide questions do not. */
function canInspectOwnWorkflow(question: string, analystToolsAllowed: boolean): boolean {
  if (!analystToolsAllowed) return true;
  if (/ของ(?:ผม|ฉัน|หนู|เรา|ตัวเอง)/u.test(question)) return true;
  if (/ทุก(?:คน|ตลาด|กลุ่ม)|ภาพรวม|ทั้งหมด|มีใคร|คนไหน/u.test(question)) return false;
  return FIRST_PERSON.test(question) || kindFromQuestion(question) !== undefined
    || (DOCUMENT_CONTEXT.test(question) && (STATUS_QUESTION.test(question) || /ล่าสุด|ข้อ\s*\d/u.test(question)));
}

const OTHER_PERSON = /ของ(?!ผม|ฉัน|หนู|เรา|ตัวเอง|กู|พี่เอง)\s*[ก-๙A-Za-z]/u;

/** Keep an explicit kind when the model is unavailable; never substitute another document type. */
export function kindFromQuestion(question: string): "withdrawal" | "return" | "damaged_return" | undefined {
  if (/คืนเสีย/u.test(question)) return "damaged_return";
  if (/ชั่งคืน|คืนดี/u.test(question)) return "return";
  if (/เบิก/u.test(question)) return "withdrawal";
  return undefined;
}

/**
 * Answer without the model (timeout, provider outage). Uses the same tools,
 * so the reply is never weaker than the evidence. Returns null when the
 * question cannot be answered safely without the model.
 */
export async function deterministicConsultantAnswer(
  supabase: Supabase,
  scope: ConsultantScope | null,
  question: string,
  today: string,
  now: number,
  analystToolsAllowed = false,
): Promise<string | null> {
  const intent = questionIntent(question);
  if (intent === "workflow") {
    if (!canInspectOwnWorkflow(question, analystToolsAllowed)) return null;
    // A named other worker needs the model to extract the name; never guess it.
    if (OTHER_PERSON.test(question)) return null;
    if (!scope) return REPLY_IDENTITY_UNVERIFIED;
    const businessDate = explicitQuestionDate(question, today);
    const transactionKind = kindFromQuestion(question);
    const dateOption = { now, ...(businessDate ? { businessDate } : {}), ...(transactionKind ? { transactionKind } : {}) };
    if (PENDING_QUESTION.test(question) && !PROBLEM_QUESTION.test(question)) {
      return pendingOutput(await getPendingSubmissions(supabase, scope, dateOption)).suggestedReply ?? null;
    }
    const itemNumber = question.match(/ข้อ\s*(\d{1,3})/u)?.[1];
    return workflowOutput(await getSubmissionDiagnosis(supabase, scope, {
      ...dateOption,
      ...(itemNumber ? { itemNumber: Number(itemNumber) } : {}),
    })).suggestedReply ?? null;
  }
  const [entry] = intent === "guide" ? findKnowledge(question) : [];
  return entry ? entry.answerThai : null;
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function answerBotSummaryForLine(
  supabase: Supabase,
  question: string,
  context: BotSummaryQuestionContext,
  dependencies: ConsultantAnswerDependencies,
): Promise<string> {
  const analystToolsAllowed = context.analystToolsAllowed !== false;
  if (!dependencies.consultantEnabled) {
    if (!analystToolsAllowed) throw new Error("Bot Summary analyst is not allowed in this chat.");
    return (await answerWithReadonlyTools(supabase, question, dependencies.openai)).answer;
  }

  const now = dependencies.now?.() ?? Date.now();
  const today = bangkokBusinessDateFromTimestamp(now) ?? new Date(now).toISOString().slice(0, 10);
  const resolution = context.lineUserId
    ? await resolveConsultantScope(
      supabase,
      { sourceId: context.sourceId, lineUserId: context.lineUserId, sourceType: context.sourceType },
      dependencies.scopeOptions,
    )
    : null;
  const scope = resolution?.ok ? resolution.scope : null;

  const previousQuestions = context.lineUserId
    ? await loadRecentBotSummaryQuestions(supabase, {
      sourceId: context.sourceId,
      lineUserId: context.lineUserId,
      destination: context.destination,
      excludeRawMessageId: context.rawMessageId,
      now,
    })
    : [];

  const extension = buildExtension(
    supabase,
    scope,
    question,
    today,
    previousQuestions,
    !analystToolsAllowed,
    // Real clock: the model-call timeouts are measured against Date.now().
    Date.now() + (dependencies.budgetMs ?? DEFAULT_BUDGET_MS),
    now,
  );

  try {
    const result = await answerWithReadonlyTools(
      supabase,
      question,
      { timeoutMs: PER_CALL_TIMEOUT_MS, ...dependencies.openai },
      undefined,
      extension,
    );
    const workflowOutputs = result.extensionOutputs
      .filter((entry) => WORKFLOW_TOOL_NAMES.has(entry.tool))
      .map((entry) => entry.output as ToolOutput);
    // Amount / settlement verification needs a SUCCESSFUL, fully-matched settlement result
    // from a management-chat analyst tool. Consultant tools and failed calls never prove it,
    // and no tool proves slip verification, so a slip claim is only ever deterministic text.
    const financeEvidence = analystToolsAllowed
      && !claimsSlipVerified(result.answer)
      && hasAuthoritativeSettlementProof(result.analystOutputs, question, result.businessDate);
    const verifiedGuideReplies = result.extensionOutputs
      .filter((entry) => entry.tool === "get_usage_guide" && entry.output.status === "ok")
      .map((entry) => entry.output.suggestedReply)
      .filter((reply): reply is string => typeof reply === "string");
    if (claimsFinanceVerified(result.answer) && !financeEvidence
      && !verifiedGuideReplies.some((reply) => compactThai(reply) === compactThai(result.answer))) {
      return workflowOutputs.at(-1)?.suggestedReply ?? REPLY_FINANCE_UNVERIFIED;
    }
    if (workflowOutputs.length > 0) return guardConsultantAnswer(result.answer, workflowOutputs);
    // A selected Analyst/guide tool cannot satisfy a document-status request.
    // Apply the same intent and scoped evidence policy on success and outage.
    if (isStatusQuestion(question)) {
      const deterministic = await deterministicConsultantAnswer(supabase, scope, question, today, now, analystToolsAllowed);
      if (deterministic) return deterministic;
      return claimsSaved(result.answer) ? REPLY_CANNOT_CONFIRM : result.answer;
    }
    const guides = result.extensionOutputs.filter((entry) =>
      entry.tool === "get_usage_guide" && entry.output.status === "ok");
    if (guides.length > 0) {
      const verifiedReplies = guides.map(({ output }) => output.suggestedReply)
        .filter((reply): reply is string => typeof reply === "string");
      // Guidance is not persistence proof. Do not infer instructional meaning
      // from model words; replace unverified save wording with trusted guidance.
      return claimsUngroundedSaved(result.answer, verifiedReplies)
        ? verifiedReplies.join("\n\n") || REPLY_CANNOT_CONFIRM
        : result.answer;
    }
    // Successful Analyst calls and quotation marks are not workflow proof.
    return claimsSaved(result.answer) ? REPLY_CANNOT_CONFIRM : result.answer;
  } catch (error) {
    const fallback = await deterministicConsultantAnswer(supabase, scope, question, today, now, analystToolsAllowed)
      .catch(() => null);
    if (fallback) return fallback;
    throw error;
  }
}
