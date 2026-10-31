/**
 * Answers one @Botsummary job: access (asker + audience) -> conversation
 * memory for that exact access -> business date -> read-only tool loop ->
 * deterministic financial rendering / grounding.
 *
 * Financial answers (P1-D): if any financial tool ran, the delivered money
 * figures and cash statuses are rendered from the tool fields
 * (financial-render.ts); the model's wording of them is discarded. A
 * non-financial answer may not state money at all, and every money-like
 * number in it must appear in THIS answer's tool outputs. Numbers in the
 * user's question are never evidence.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import {
  answerWithReadonlyTools,
  questionNamesDate,
  resolveAnalystBusinessDate,
  type AnalystToolExecutor,
} from "@/lib/ai/readonly-analyst";
import type { AssistantModelProvider } from "@/lib/ai/model-provider";
import type { ReadonlyAnalystToolName } from "@/lib/ai/readonly-tools";
import { isBotSummaryAnalystSourceAllowed } from "@/lib/ai/line-command";
import {
  createScopedToolExecutor,
  decideJobAccess,
  readonlyDataReader,
  resolveGroupPolicy,
  scopeInstructions,
  type GroupPolicyResolution,
  type JobAccess,
  type ScopedDataReader,
} from "./authorization";
import { containsFinancialClaim, FINANCIAL_TOOLS, renderFinancialOutput } from "./financial-render";
import { AssistantStoreError, type AssistantJob, type AssistantJobStore, type ConversationTurn } from "./job-store";
import { classifyAssistantError } from "./errors";
import type { AssistantAnswer } from "./worker";

type Supabase = SupabaseClient<Database>;

export const ASSISTANT_DIRECT_CHAT_REPLY =
  "ขออภัยครับ ตอนนี้ @Botsummary ตอบเฉพาะในกลุ่ม LINE ที่ได้รับอนุมัติ กรุณาถามในกลุ่มครับ";
export const ASSISTANT_UNGROUNDED_REPLY =
  "ขออภัยครับ ตัวเลขในคำตอบตรวจสอบกับข้อมูลระบบไม่ผ่าน จึงไม่ส่งคำตอบนี้ กรุณาถามใหม่ให้เจาะจงขึ้น เช่น ระบุตลาดหรือชื่อคนขาย";
export const ASSISTANT_GROUP_REFUSAL_REPLY =
  "ขออภัยครับ กลุ่มนี้ยังไม่ได้รับอนุมัติให้ใช้ @Botsummary กรุณาติดต่อหัวหน้างานหรือแอดมิน";
export const ASSISTANT_SCOPE_CHANGED_REPLY =
  "ขออภัยครับ สิทธิ์ของกลุ่มนี้เปลี่ยนไปก่อนส่งคำตอบ จึงไม่ส่งคำตอบเดิม กรุณาถามใหม่อีกครั้ง";

const HISTORY_TURNS = 4;
const FOLLOW_UP = /^(?:แล้ว|และ|ส่วน)|(?:ล่ะ|หละ|ละ|ด้วย)\s*(?:ครับ|คะ|ค่ะ|จ้า|จ้ะ)?\s*[?？]*\s*$/u;

export function isFollowUpQuestion(question: string): boolean {
  return FOLLOW_UP.test(question.normalize("NFC").trim());
}

/**
 * The business date the answer is about. An explicit day in the question is
 * resolved against the day the question was ASKED (not when a retry runs). A
 * follow-up without a day ("แล้วของพี่ขวัญล่ะ?") keeps the previous turn's day.
 */
export function resolveJobBusinessDate(
  question: string,
  askedBusinessDate: string,
  turns: readonly ConversationTurn[],
): string {
  if (questionNamesDate(question)) return resolveAnalystBusinessDate(question, askedBusinessDate);
  const previous = turns.at(-1);
  if (previous && isFollowUpQuestion(question)) return previous.businessDate;
  return askedBusinessDate;
}

function thaiDigitsToArabic(value: string): string {
  return value.replace(/[๐-๙]/gu, (digit) => String("๐๑๒๓๔๕๖๗๘๙".indexOf(digit)));
}

function numbersIn(text: string): number[] {
  return [...thaiDigitsToArabic(text).matchAll(/-?\d[\d,]*(?:\.\d+)?/gu)]
    .map((match) => Number(match[0].replace(/,/g, "")))
    .filter(Number.isFinite);
}

/** A figure worth checking: has decimals or is at least 100, and is not a year. */
function moneyLike(raw: string, value: number): boolean {
  const abs = Math.abs(value);
  if (/\.\d/u.test(raw)) return true;
  if (abs < 100) return false;
  const isYear = !raw.includes(",") && ((abs >= 1900 && abs <= 2100) || (abs >= 2400 && abs <= 2700));
  return !isYear;
}

/** Money-like numbers in `answer` that appear in none of `groundingTexts` (tool outputs only). */
export function ungroundedNumbers(answer: string, groundingTexts: readonly string[]): number[] {
  const grounded = groundingTexts.flatMap(numbersIn).map(Math.abs);
  const result: number[] = [];
  for (const match of thaiDigitsToArabic(answer).matchAll(/-?\d[\d,]*(?:\.\d+)?/gu)) {
    const value = Number(match[0].replace(/,/g, ""));
    if (!Number.isFinite(value) || !moneyLike(match[0], value)) continue;
    if (!grounded.some((candidate) => Math.abs(candidate - Math.abs(value)) < 0.006)) result.push(value);
  }
  return result;
}

export interface AssistantCoreDeps {
  /** A client whose every request is bounded by the job deadline. */
  supabase: Supabase;
  store: AssistantJobStore;
  provider: AssistantModelProvider;
  resolveGroupPolicy?: (sourceId: string) => Promise<GroupPolicyResolution>;
  /** Signed-webhook source allowlist, re-checked at answer and delivery time. */
  sourceAllowed?: (sourceId: string) => boolean;
  /** Data behind the authorization check; defaults to the read-only tools. Test/demo seam. */
  readData?: ScopedDataReader;
}

export type JobAccessResolution =
  | { ok: true; access: JobAccess }
  | { ok: false; kind: "denied"; reason: string; notice: string }
  | { ok: false; kind: "transient" };

/**
 * The CURRENT access for a job: re-read on every answer and before every
 * delivery. Only an approved group (allowlisted chat + approving policy) gets
 * data; its scope comes from the group policy alone.
 */
export async function resolveJobAccess(job: AssistantJob, deps: AssistantCoreDeps): Promise<JobAccessResolution> {
  if (job.source_type === "user") {
    return { ok: false, kind: "denied", reason: "direct_chat", notice: ASSISTANT_DIRECT_CHAT_REPLY };
  }
  if (!(deps.sourceAllowed ?? ((id) => isBotSummaryAnalystSourceAllowed(id)))(job.source_id)) {
    return { ok: false, kind: "denied", reason: "source_not_allowed", notice: ASSISTANT_GROUP_REFUSAL_REPLY };
  }
  const policy = await (deps.resolveGroupPolicy ?? ((id) => resolveGroupPolicy(deps.supabase, id)))(job.source_id);
  if (!policy.ok) return { ok: false, kind: "transient" };
  const decision = decideJobAccess({
    lineUserId: job.line_user_id,
    sourceType: job.source_type,
    sourceId: job.source_id,
    groupPolicy: policy.policy,
  });
  if (!decision.ok) {
    return {
      ok: false,
      kind: "denied",
      reason: decision.reason,
      notice: decision.reason === "direct_chat" ? ASSISTANT_DIRECT_CHAT_REPLY : ASSISTANT_GROUP_REFUSAL_REPLY,
    };
  }
  return { ok: true, access: decision.access };
}

/**
 * Before a recorded data answer is delivered (fresh or after a crash): is the
 * access it was produced under still exactly the current one?
 */
export async function revalidateAssistantJob(
  job: AssistantJob,
  deps: AssistantCoreDeps,
  scopeKey: string | null = job.answer_scope_key,
): Promise<"current" | "changed" | "transient"> {
  const resolution = await resolveJobAccess(job, deps);
  if (!resolution.ok) return resolution.kind === "transient" ? "transient" : "changed";
  return scopeKey !== null && resolution.access.scopeKey === scopeKey ? "current" : "changed";
}

export async function answerAssistantJob(
  job: AssistantJob,
  context: { deadlineAt: number; signal: AbortSignal },
  deps: AssistantCoreDeps,
): Promise<AssistantAnswer> {
  const accessResult = await resolveJobAccess(job, deps);
  if (!accessResult.ok) {
    // Transient: retried by the worker instead of telling the user "no access".
    if (accessResult.kind === "transient") throw new AssistantStoreError("policy_lookup", null);
    logger.info("ai assistant request refused", { jobId: job.id, reason: accessResult.reason });
    return { text: accessResult.notice, kind: "notice" };
  }
  const { access } = accessResult;

  let turns: ConversationTurn[] = [];
  try {
    turns = await deps.store.loadTurns(
      { destination: job.destination, sourceId: job.source_id, lineUserId: job.line_user_id },
      job.event_timestamp_ms,
      job.id,
      access.scopeKey,
      HISTORY_TURNS,
    );
  } catch (error) {
    // Memory is context only; answering without it is safe.
    logger.warn("ai assistant memory unavailable", { jobId: job.id, code: classifyAssistantError(error).code });
  }

  const businessDate = resolveJobBusinessDate(job.question, job.asked_business_date, turns);
  const outputs: Array<{ tool: ReadonlyAnalystToolName; output: Record<string, unknown> }> = [];
  const denied: string[] = [];
  const scoped = createScopedToolExecutor(deps.readData ?? readonlyDataReader(deps.supabase), access, (tool, decision) => {
    if (decision !== "allowed") denied.push(`${tool}:${decision}`);
  });
  const executeTool: AnalystToolExecutor = async (request) => {
    const output = await scoped(request);
    outputs.push({ tool: request.tool, output });
    return output;
  };

  const result = await answerWithReadonlyTools(
    deps.supabase,
    job.question,
    {
      provider: deps.provider,
      history: turns.map((turn) => ({ question: turn.question, answer: turn.answer, businessDate: turn.businessDate })),
      allowedTools: access.allowedTools,
      executeTool,
      extraInstructions: scopeInstructions(access),
      budgetMs: Math.max(0, context.deadlineAt - Date.now()),
      signal: context.signal,
    },
    businessDate,
  );

  const toolNames = result.toolExecutions.map((execution) => execution.tool);
  const financial = outputs.filter((entry) => FINANCIAL_TOOLS.has(entry.tool));
  const other = outputs.filter((entry) => !FINANCIAL_TOOLS.has(entry.tool));
  const modelTextIsSafe = (grounding: typeof outputs) => !containsFinancialClaim(result.answer)
    && ungroundedNumbers(result.answer, grounding.map((entry) => JSON.stringify(entry.output))).length === 0;
  const usage = {
    ...result.usage,
    provider: deps.provider.name,
    deniedToolCalls: denied,
    financialRendered: financial.length > 0,
  };

  let text: string;
  if (financial.length > 0) {
    const rendered = [...new Set(financial.map((entry) => renderFinancialOutput(entry.output)).filter(Boolean))];
    // Non-financial context from the model only when it states no money and
    // every figure in it comes from a non-financial tool of this answer.
    if (other.length > 0 && modelTextIsSafe(other)) rendered.push(result.answer);
    text = rendered.join("\n\n");
  } else if (!modelTextIsSafe(outputs)) {
    logger.warn("ai assistant answer withheld: unsupported figures", { jobId: job.id, tools: toolNames });
    return { text: ASSISTANT_UNGROUNDED_REPLY, kind: "notice", usage, toolNames };
  } else {
    text = result.answer;
  }

  return {
    text,
    kind: "answer",
    usage,
    toolNames,
    turn: { businessDate: result.businessDate, context: turnContext(result.toolExecutions) },
    scopeKey: access.scopeKey,
  };
}

/** What the next turn may need ("แล้วของพี่ขวัญล่ะ" = same tool, new staff). Bounded well under the 4 KB column CHECK. */
function turnContext(
  executions: ReadonlyArray<{ tool: string; arguments: Record<string, unknown> }>,
): Record<string, unknown> {
  const tools = executions.slice(0, 6).map((execution) => ({
    tool: execution.tool,
    arguments: Object.fromEntries(Object.entries(execution.arguments)
      .filter(([, value]) => value === null || typeof value === "number"
        || (typeof value === "string" && value.length <= 60))
      .slice(0, 4)),
  }));
  const context = { tools };
  return JSON.stringify(context).length <= 2_000 ? context : { tools: tools.map(({ tool }) => ({ tool })) };
}
