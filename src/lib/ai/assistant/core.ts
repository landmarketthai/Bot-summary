/**
 * Answers one @Botsummary job: authorization -> conversation memory ->
 * business date -> read-only tool loop -> grounding check.
 *
 * Grounding: money-like numbers in the model's answer must appear in the
 * tool outputs of THIS answer (or in the question). An answer that states a
 * figure no tool returned — a recalculated total, a remembered number, a
 * guess — is replaced by a refusal instead of reaching LINE.
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
import {
  allowedToolsFor,
  createScopedToolExecutor,
  readonlyDataReader,
  resolveAssistantScope,
  scopeInstructions,
  type ScopedDataReader,
  type ScopeResolution,
} from "./authorization";
import { AssistantStoreError, type AssistantJob, type AssistantJobStore, type ConversationTurn } from "./job-store";
import { classifyAssistantError } from "./errors";
import type { AssistantAnswer } from "./worker";

type Supabase = SupabaseClient<Database>;

export const ASSISTANT_NO_PERMISSION_REPLY =
  "ขออภัยครับ บัญชี LINE นี้ยังไม่ได้รับสิทธิ์ดูข้อมูลผ่าน @Botsummary กรุณาติดต่อหัวหน้างานหรือแอดมิน";
export const ASSISTANT_UNGROUNDED_REPLY =
  "ขออภัยครับ ตัวเลขในคำตอบตรวจสอบกับข้อมูลระบบไม่ผ่าน จึงไม่ส่งคำตอบนี้ กรุณาถามใหม่ให้เจาะจงขึ้น เช่น ระบุตลาดหรือชื่อคนขาย";

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

/** Money-like numbers in `answer` that appear in no tool output and not in the question. */
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
  resolveScope?: (lineUserId: string) => Promise<ScopeResolution>;
  /** Data behind the authorization check; defaults to the read-only tools. Test/demo seam. */
  readData?: ScopedDataReader;
}

export async function answerAssistantJob(
  job: AssistantJob,
  context: { deadlineAt: number; signal: AbortSignal },
  deps: AssistantCoreDeps,
): Promise<AssistantAnswer> {
  const resolution = await (deps.resolveScope ?? ((id) => resolveAssistantScope(deps.supabase, id)))(job.line_user_id);
  if (!resolution.ok) {
    if (resolution.reason === "grant_lookup_failed") {
      // Transient: retried by the worker instead of telling the user "no access".
      throw new AssistantStoreError("grant_lookup", null);
    }
    logger.info("ai assistant request without permission", { jobId: job.id, reason: resolution.reason });
    return { text: ASSISTANT_NO_PERMISSION_REPLY, kind: "notice" };
  }
  const { scope } = resolution;

  let turns: ConversationTurn[] = [];
  try {
    turns = await deps.store.loadTurns(
      { destination: job.destination, sourceId: job.source_id, lineUserId: job.line_user_id },
      job.event_timestamp_ms,
      HISTORY_TURNS,
    );
  } catch (error) {
    // Memory is context only; answering without it is safe.
    logger.warn("ai assistant memory unavailable", { jobId: job.id, code: classifyAssistantError(error).code });
  }

  const businessDate = resolveJobBusinessDate(job.question, job.asked_business_date, turns);
  const outputs: string[] = [];
  const denied: string[] = [];
  const scoped = createScopedToolExecutor(deps.readData ?? readonlyDataReader(deps.supabase), scope, (tool, decision) => {
    if (decision !== "allowed") denied.push(`${tool}:${decision}`);
  });
  const executeTool: AnalystToolExecutor = async (request) => {
    const output = await scoped(request);
    outputs.push(JSON.stringify(output));
    return output;
  };

  const result = await answerWithReadonlyTools(
    deps.supabase,
    job.question,
    {
      provider: deps.provider,
      history: turns.map((turn) => ({ question: turn.question, answer: turn.answer, businessDate: turn.businessDate })),
      allowedTools: allowedToolsFor(scope),
      executeTool,
      extraInstructions: scopeInstructions(scope),
      budgetMs: Math.max(0, context.deadlineAt - Date.now()),
      signal: context.signal,
    },
    businessDate,
  );

  const ungrounded = ungroundedNumbers(result.answer, [...outputs, job.question]);
  const usage = {
    ...result.usage,
    provider: deps.provider.name,
    deniedToolCalls: denied,
    ungroundedNumberCount: ungrounded.length,
  };
  if (ungrounded.length > 0) {
    logger.warn("ai assistant answer withheld: ungrounded figures", {
      jobId: job.id,
      count: ungrounded.length,
      tools: result.toolExecutions.map((execution) => execution.tool),
    });
    return { text: ASSISTANT_UNGROUNDED_REPLY, kind: "notice", usage, toolNames: result.toolExecutions.map((e) => e.tool) };
  }

  return {
    text: result.answer,
    kind: "answer",
    usage,
    toolNames: result.toolExecutions.map((execution) => execution.tool),
    turn: { businessDate: result.businessDate, context: turnContext(scope.role, result.toolExecutions) },
  };
}

/** What the next turn may need ("แล้วของพี่ขวัญล่ะ" = same tool, new staff). Bounded well under the 4 KB column CHECK. */
function turnContext(
  role: string,
  executions: ReadonlyArray<{ tool: string; arguments: Record<string, unknown> }>,
): Record<string, unknown> {
  const tools = executions.slice(0, 6).map((execution) => ({
    tool: execution.tool,
    arguments: Object.fromEntries(Object.entries(execution.arguments)
      .filter(([, value]) => value === null || typeof value === "number"
        || (typeof value === "string" && value.length <= 60))
      .slice(0, 4)),
  }));
  const context = { role, tools };
  return JSON.stringify(context).length <= 2_000 ? context : { role, tools: tools.map(({ tool }) => ({ tool })) };
}
