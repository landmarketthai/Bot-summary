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
import {
  CONSULTANT_ACTION_GUIDES,
  CONSULTANT_KNOWLEDGE,
  CONSULTANT_KNOWLEDGE_VERSION,
  findKnowledge,
  getKnowledge,
} from "./knowledge";
import type { ConsultantScope } from "./types";
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

const DEFAULT_BUDGET_MS = 25_000;
const PER_CALL_TIMEOUT_MS = 12_000;

export function botSummaryUsageReply(consultantEnabled: boolean): string {
  if (!consultantEnabled) return BOT_SUMMARY_USAGE_REPLY;
  return [
    BOT_SUMMARY_USAGE_REPLY,
    "• @Botsummary ชั่งคืนต้องพิมพ์ยังไง",
    "• @Botsummary เมื่อกี้รายการผมเข้าหรือยัง",
    "• @Botsummary ทำไมข้อ 22 ไม่ผ่าน",
  ].join("\n");
}

// ── Thai fixed replies ───────────────────────────────────────────────────────

const REPLY_FORBIDDEN =
  "ดูสถานะได้เฉพาะรายการที่คุณส่งเองครับ ถ้าต้องการดูรายการของคนอื่น กรุณาสอบถามผู้ดูแลครับ";
const REPLY_UNAVAILABLE =
  "ตอนนี้ตรวจสถานะรายการจากระบบไม่ได้ชั่วคราวครับ ยังยืนยันไม่ได้ว่าบันทึกแล้วหรือยัง กรุณาลองถามใหม่อีกครั้งครับ";
const REPLY_IDENTITY_UNVERIFIED =
  "ยังยืนยันตัวผู้ถามไม่ได้ จึงดูสถานะรายการให้ไม่ได้ครับ กรุณาถามจากบัญชีไลน์ที่ใช้ส่งรายการครับ";
const REPLY_NONE =
  "ไม่พบรายการผักที่คุณส่งในช่วง 3 วันนี้ในแชทนี้ครับ ถ้าเพิ่งส่ง กรุณาดูข้อความตอบกลับของบอทหรือถามใหม่อีกครั้งครับ";

function candidateLine(candidate: SubmissionCandidate): string {
  return [candidate.transactionKindThai, candidate.staff, candidate.market, candidate.businessDate]
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
    staff: evidence.staff,
    market: evidence.market,
    transactionKindThai: evidence.transactionKindThai,
    state: evidence.state,
    persisted: evidence.persisted,
    savedItemCount: evidence.savedItemCount,
    acceptedButNotSavedCount: evidence.acceptedUnsavedCount,
    needsReviewCount: evidence.needsReviewCount,
    blockers: evidence.blockers.slice(0, 5).map((blocker) => ({
      itemNumber: blocker.itemNumber,
      productName: blocker.productName,
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

const WORKFLOW_TOOLS = [
  {
    type: "function",
    name: "get_submission_status",
    description: "สถานะจริงของรายการผัก (เบิก/ชั่งคืน/คืนเสีย) ล่าสุดที่ส่ง ว่าบันทึกแล้ว รอตรวจ หรือยังไม่บันทึก",
    parameters: {
      type: "object",
      properties: {
        staff: STAFF_PARAM,
        transaction_kind: { type: "string", enum: KIND_ENUM, description: "any=ไม่ระบุ" },
      },
      required: ["staff", "transaction_kind"],
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
      properties: { staff: STAFF_PARAM },
      required: ["staff"],
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
        item_number: { type: "integer", description: "เลขข้อที่ผู้ใช้ถาม ถ้าไม่ระบุให้ใส่ 0" },
      },
      required: ["staff", "item_number"],
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
  const dateOption = { now, ...(businessDate ? { businessDate } : {}) };
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
      const staff = staffOption(stringArg(args, "staff"));
      switch (name) {
        case "get_submission_status": {
          const kind = kindArg(args);
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

const INTERNAL_TERMS =
  /failed_closed|terminaliz|partial_capture|pending_session|finaliz|finalization|accountability|session_key|\bnull\b|undefined/iu;
/** "บันทึกแล้ว/เรียบร้อย/สำเร็จ" asserted as fact — not quoted, not negated by ยัง/ไม่ just before. */
export function claimsSaved(text: string): boolean {
  for (const match of text.matchAll(/บันทึก(?:แล้ว|ไว้แล้ว|เรียบร้อย|สำเร็จ)/gu)) {
    const before = text.slice(Math.max(0, match.index - 8), match.index);
    if (/[“"']\s*$/u.test(before) || /(?:ยัง|ไม่)(?:ได้)?\s*$/u.test(before)) continue;
    return true;
  }
  return false;
}

/**
 * Replace a model answer that contradicts the evidence with the deterministic
 * reply. Only workflow answers are checked: knowledge answers legitimately
 * quote the bot's own “บันทึกแล้ว” message.
 */
export function guardConsultantAnswer(
  answer: string,
  workflowOutputs: ToolOutput[],
): string {
  if (workflowOutputs.length === 0) return answer;
  const fallback = workflowOutputs.at(-1)?.suggestedReply;
  if (!fallback) return answer;
  if (INTERNAL_TERMS.test(answer)) return fallback;
  const provenSaved = workflowOutputs.some((output) => {
    const submission = output.submission as { persisted?: unknown } | undefined;
    const submissions = output.submissions as Array<{ persisted?: unknown }> | undefined;
    return submission?.persisted === true || submissions?.some((entry) => entry.persisted === true);
  });
  if (!provenSaved && claimsSaved(answer)) return fallback;
  return answer;
}

const STATUS_QUESTION =
  /เข้า(?:หรือ)?ยัง|เข้าไหม|เข้ามั้ย|สำเร็จ(?:ไหม|มั้ย|หรือยัง)|บันทึก(?:แล้ว)?(?:หรือยัง|ไหม|มั้ย)|เป็นยังไง|เป็นไง|ล่าสุด|ไม่ขึ้น|ยังไม่เข้า|ติดอะไร/u;
const PENDING_QUESTION = /ค้าง|ยังไม่จบ|ยังไม่เสร็จ/u;
const PROBLEM_QUESTION = /ทำไม|ไม่ผ่าน|ต้องแก้|แก้อะไร|ข้อไหน|ผิด|ส่งใหม่|ต่อยังไง|ยังไงต่อ|ทำอะไรต่อ/u;
const OTHER_PERSON = /ของ(?!ผม|ฉัน|หนู|เรา|ตัวเอง|กู|พี่เอง)\s*[ก-๙A-Za-z]/u;

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
): Promise<string | null> {
  const asksStatus = STATUS_QUESTION.test(question) || PENDING_QUESTION.test(question)
    || PROBLEM_QUESTION.test(question);
  if (asksStatus) {
    // A named other worker needs the model to extract the name; never guess it.
    if (OTHER_PERSON.test(question)) return null;
    if (!scope) return REPLY_IDENTITY_UNVERIFIED;
    const businessDate = explicitQuestionDate(question, today);
    const dateOption = { now, ...(businessDate ? { businessDate } : {}) };
    if (PENDING_QUESTION.test(question) && !PROBLEM_QUESTION.test(question)) {
      return pendingOutput(await getPendingSubmissions(supabase, scope, dateOption)).suggestedReply ?? null;
    }
    const itemNumber = question.match(/ข้อ\s*(\d{1,3})/u)?.[1];
    return workflowOutput(await getSubmissionDiagnosis(supabase, scope, {
      ...dateOption,
      ...(itemNumber ? { itemNumber: Number(itemNumber) } : {}),
    })).suggestedReply ?? null;
  }
  const [entry] = findKnowledge(question);
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
    now + (dependencies.budgetMs ?? DEFAULT_BUDGET_MS),
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
    return guardConsultantAnswer(result.answer, workflowOutputs);
  } catch (error) {
    const fallback = await deterministicConsultantAnswer(supabase, scope, question, today, now)
      .catch(() => null);
    if (fallback) return fallback;
    throw error;
  }
}
