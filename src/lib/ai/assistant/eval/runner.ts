/**
 * Runs the answer-level evaluation through the REAL answer pipeline
 * (answerAssistantJob: access, memory, business date, tool loop, financial
 * rendering, grounding) with fixture data behind the real authorization
 * layer. Only the model provider varies: the scripted stand-in (harness
 * check) or the live provider (GPT-6 Luna). Never touches Production data,
 * LINE or the job database.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { estimateAnalystCostUsd } from "@/lib/ai/openai-analyst";
import type { AssistantModelProvider } from "@/lib/ai/model-provider";
import { withTimeout } from "@/lib/slips/io-timeout";
import type { GroupPolicy } from "../authorization";
import { answerAssistantJob, type AssistantCoreDeps } from "../core";
import { classifyAssistantError } from "../errors";
import { createFixtureDataReader, FIXTURE_MARKETS, FIXTURE_MONEY_SATANG, FIXTURE_TODAY, type FixtureRead } from "../testing/fixture-data";
import { MemoryAssistantJobStore } from "../testing/memory-job-store";
import type { AnswerEvalCase, EvalCategory, EvalChat } from "./answer-eval-set";
import { gradeAnswer, type EvalError, type EvalErrorCategory } from "./grader";

export interface CaseUsage {
  modelCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  usageComplete: boolean;
}

export interface CaseResult {
  id: string;
  category: EvalCategory;
  chat: EvalChat;
  question: string;
  pass: boolean;
  errors: EvalError[];
  answer: string | null;
  kind: "answer" | "notice" | null;
  toolsUsed: string[];
  expectedTools: string[];
  /** Diagnostic only; not part of pass/fail. null when no tool is expected. */
  toolMatch: boolean | null;
  /** Final question only (earlier turns of the case excluded). */
  latencyMs: number;
  /** All turns of the case, earlier turns included. */
  usage: CaseUsage;
  costUsd: number | null;
}

export interface EvalSummary {
  total: number;
  run: number;
  passed: number;
  failed: number;
  notRun: number;
  byCategory: Record<string, { total: number; passed: number }>;
  errorCategories: Partial<Record<EvalErrorCategory, number>>;
  toolMatch: { expected: number; matched: number };
  latencyMs: { p50: number; p95: number; max: number };
  tokens: CaseUsage;
  costUsd: number | null;
}

const EVAL_DESTINATION = "Ueval-bot";
const GROUPS: Record<"approved_group" | "market_group" | "unapproved_group", { sourceId: string; policy: GroupPolicy | null }> = {
  approved_group: { sourceId: "Ceval-approved", policy: { sourceId: "Ceval-approved", markets: null } },
  market_group: { sourceId: "Ceval-paseo", policy: { sourceId: "Ceval-paseo", markets: new Set([FIXTURE_MARKETS.PASEO]) } },
  unapproved_group: { sourceId: "Ceval-unapproved", policy: null },
};
function chatSource(chat: EvalChat): { sourceType: "user" | "group"; sourceId: string; lineUserId: string } {
  if (chat === "direct_chat") return { sourceType: "user", sourceId: "Ueval-member", lineUserId: "Ueval-member" };
  return { sourceType: "group", sourceId: GROUPS[chat].sourceId, lineUserId: "Ueval-member" };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export async function runAnswerEval(options: {
  provider: AssistantModelProvider;
  cases: readonly AnswerEvalCase[];
  perCaseBudgetMs?: number;
  /** Stop starting new cases once the estimated spend reaches this (needs prices). */
  maxUsd?: number | null;
  env?: Record<string, string | undefined>;
  onResult?: (result: CaseResult) => void;
}): Promise<{ results: CaseResult[]; summary: EvalSummary }> {
  const env = options.env ?? process.env;
  const results: CaseResult[] = [];
  let spentUsd = 0;
  let costKnown = true;

  for (const testCase of options.cases) {
    const chat = testCase.chat ?? "approved_group";
    const expectedTools = testCase.expect.tools ?? [];
    if (options.maxUsd != null && spentUsd >= options.maxUsd) {
      results.push({
        id: testCase.id, category: testCase.category, chat, question: testCase.question, pass: false,
        errors: [{ category: "not_run_budget", detail: `budget ${options.maxUsd} USD reached` }],
        answer: null, kind: null, toolsUsed: [], expectedTools, toolMatch: null, latencyMs: 0,
        usage: { modelCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, usageComplete: true }, costUsd: 0,
      });
      continue;
    }

    const store = new MemoryAssistantJobStore();
    const reads: FixtureRead[] = [];
    const source = chatSource(chat);
    const deps: AssistantCoreDeps = {
      supabase: {} as SupabaseClient<Database>,
      store,
      provider: options.provider,
      sourceAllowed: () => true,
      resolveGroupPolicy: async (sourceId) => ({
        ok: true,
        policy: Object.values(GROUPS).find((group) => group.sourceId === sourceId)?.policy ?? null,
      }),
      readData: createFixtureDataReader(reads),
    };
    const usage: CaseUsage = { modelCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, usageComplete: true };
    const addUsage = (raw: unknown) => {
      const u = (raw ?? {}) as Partial<CaseUsage>;
      usage.modelCalls += u.modelCalls ?? 0;
      usage.inputTokens += u.inputTokens ?? 0;
      usage.cachedInputTokens += u.cachedInputTokens ?? 0;
      usage.outputTokens += u.outputTokens ?? 0;
      if (u.usageComplete === false) usage.usageComplete = false;
    };

    let seq = 0;
    const ask = async (question: string) => {
      seq += 1;
      await store.enqueue({
        lineEventId: `${testCase.id}-${seq}`, rawMessageId: null, destination: EVAL_DESTINATION,
        sourceType: source.sourceType, sourceId: source.sourceId, lineUserId: source.lineUserId, question,
        askedBusinessDate: FIXTURE_TODAY, eventTimestampMs: 1_793_000_000_000 + seq, replyToken: null, replyTokenExpiresAt: null,
      });
      const [job] = await store.claim("eval", { limit: 1, leaseSeconds: 300, maxRunning: 5 });
      const budget = options.perCaseBudgetMs ?? 45_000;
      const deadlineAt = Date.now() + budget;
      const answer = await withTimeout("eval answer", budget, (signal) => answerAssistantJob(job!, { deadlineAt, signal }, deps));
      addUsage(answer.usage);
      await store.recordAnswer(job!.id, job!.lease_token!, {
        answer: answer.text, kind: answer.kind ?? "answer", turn: answer.turn ?? null,
        scopeKey: answer.scopeKey ?? null,
      });
      await store.complete(job!.id, job!.lease_token!, "completed");
      return answer;
    };

    let result: CaseResult;
    let readsBeforeFinal = 0;
    let started = Date.now();
    try {
      for (const previous of testCase.previous ?? []) await ask(previous);
      readsBeforeFinal = reads.length;
      started = Date.now();
      const answer = await ask(testCase.question);
      const latencyMs = Date.now() - started;
      const kind = answer.kind ?? "answer";
      const errors = gradeAnswer(testCase, { text: answer.text, kind }, FIXTURE_MONEY_SATANG);
      const toolsUsed: string[] = [...new Set(reads.slice(readsBeforeFinal).map((read) => read.request.tool))];
      result = {
        id: testCase.id, category: testCase.category, chat, question: testCase.question,
        pass: errors.length === 0, errors, answer: answer.text, kind, toolsUsed, expectedTools,
        toolMatch: expectedTools.length ? expectedTools.some((tool) => toolsUsed.includes(tool)) : null,
        latencyMs, usage, costUsd: null,
      };
    } catch (error) {
      const classified = classifyAssistantError(error);
      result = {
        id: testCase.id, category: testCase.category, chat, question: testCase.question, pass: false,
        errors: [{
          category: classified.code === "answer_timeout" || classified.code === "provider_timeout" ? "timeout" : "provider_error",
          detail: classified.code,
        }],
        answer: null, kind: null, toolsUsed: [...new Set(reads.slice(readsBeforeFinal).map((read) => read.request.tool))],
        expectedTools, toolMatch: expectedTools.length ? false : null, latencyMs: Date.now() - started, usage, costUsd: null,
      };
    }
    const cost = usage.modelCalls > 0 && usage.usageComplete ? estimateAnalystCostUsd(usage, env) : usage.modelCalls === 0 ? 0 : null;
    result.costUsd = cost;
    if (cost === null) costKnown = false;
    else spentUsd += cost;
    results.push(result);
    options.onResult?.(result);
  }

  const run = results.filter((result) => !result.errors.some((error) => error.category === "not_run_budget"));
  const byCategory: EvalSummary["byCategory"] = {};
  const errorCategories: EvalSummary["errorCategories"] = {};
  for (const result of results) {
    byCategory[result.category] ??= { total: 0, passed: 0 };
    byCategory[result.category]!.total += 1;
    if (result.pass) byCategory[result.category]!.passed += 1;
    for (const category of new Set(result.errors.map((error) => error.category))) {
      errorCategories[category] = (errorCategories[category] ?? 0) + 1;
    }
  }
  const latencies = run.map((result) => result.latencyMs);
  const tokens = results.reduce<CaseUsage>((sum, result) => ({
    modelCalls: sum.modelCalls + result.usage.modelCalls,
    inputTokens: sum.inputTokens + result.usage.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + result.usage.cachedInputTokens,
    outputTokens: sum.outputTokens + result.usage.outputTokens,
    usageComplete: sum.usageComplete && result.usage.usageComplete,
  }), { modelCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, usageComplete: true });
  const withTools = run.filter((result) => result.toolMatch !== null);
  return {
    results,
    summary: {
      total: results.length,
      run: run.length,
      passed: run.filter((result) => result.pass).length,
      failed: run.filter((result) => !result.pass).length,
      notRun: results.length - run.length,
      byCategory,
      errorCategories,
      toolMatch: { expected: withTools.length, matched: withTools.filter((result) => result.toolMatch).length },
      latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: Math.max(0, ...latencies) },
      tokens,
      costUsd: costKnown ? Math.round(spentUsd * 1_000_000) / 1_000_000 : null,
    },
  };
}
