/**
 * Thai evaluation for @Botsummary. Never touches Production: business data
 * is the invented fixture set and the queue is in memory.
 *
 *   bun scripts/ai-assistant-thai-eval.ts                 # A + B
 *   bun scripts/ai-assistant-thai-eval.ts --live          # + C, needs OPENAI_API_KEY (costs tokens)
 *   bun scripts/ai-assistant-thai-eval.ts --out docs/ai-assistant/thai-eval-results.md
 *
 * A  deterministic backend rules: business date, follow-up detection and the
 *    server-side authorization decision for a staff requester.
 * B  full answer pipeline with the SCRIPTED stand-in model: proves the
 *    harness (tools offered, executed, grounded, remembered). It is NOT a
 *    measure of GPT-6 Luna quality.
 * C  the same pipeline with the real provider (GPT-6 Luna by default).
 */
import { writeFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import type { ReadonlyAnalystToolRequest } from "../src/lib/ai/readonly-tools";
import { createOpenAIResponsesProvider, type AssistantModelProvider } from "../src/lib/ai/model-provider";
import { authorizeToolRequest, type AssistantScope } from "../src/lib/ai/assistant/authorization";
import { answerAssistantJob, isFollowUpQuestion, resolveJobBusinessDate } from "../src/lib/ai/assistant/core";
import { MemoryAssistantJobStore } from "../src/lib/ai/assistant/testing/memory-job-store";
import { createFixtureDataReader, FIXTURE_MARKETS, type FixtureRead } from "../src/lib/ai/assistant/testing/fixture-data";
import { ScriptedThaiModel } from "../src/lib/ai/assistant/testing/scripted-provider";
import { THAI_EVAL_ASKED_DATE, THAI_EVAL_SET, type ThaiEvalCase } from "../src/lib/ai/assistant/testing/thai-eval-set";

const STAFF_DAM: AssistantScope = {
  lineUserId: "Udam", role: "staff", staffLabel: "ดำ", markets: new Set([FIXTURE_MARKETS.RATCHAPHRUEK]), grantSource: "grant",
};
const SUPERVISOR: AssistantScope = {
  lineUserId: "Uboss", role: "supervisor", staffLabel: null, markets: null, grantSource: "env_supervisor",
};

function expectedRequest(item: ThaiEvalCase): ReadonlyAnalystToolRequest | null {
  if (!item.expectedTool) return null;
  return { tool: item.expectedTool, businessDate: item.expectedBusinessDate, staff: null, market: null, days: 2, ...item.expectedArgs } as unknown as ReadonlyAnalystToolRequest;
}

function sectionA() {
  return THAI_EVAL_SET.map((item) => {
    const turns = item.previous
      ? [{ question: item.previous, answer: "-", businessDate: resolveJobBusinessDate(item.previous, THAI_EVAL_ASKED_DATE, []), context: {}, eventTimestampMs: 1 }]
      : [];
    const date = resolveJobBusinessDate(item.question, THAI_EVAL_ASKED_DATE, turns);
    const followUp = isFollowUpQuestion(item.question);
    const request = expectedRequest(item);
    const decision = request === null ? "no_tool" : (() => {
      const result = authorizeToolRequest(STAFF_DAM, request);
      return result.ok ? "allowed" : result.reason;
    })();
    return {
      id: item.id,
      date: date === item.expectedBusinessDate,
      followUp: followUp === item.expectedFollowUp,
      auth: decision === item.staffDecision,
      detail: `${date} / followUp=${followUp} / ${decision}`,
    };
  });
}

async function pipeline(provider: AssistantModelProvider) {
  const rows: Array<{ id: string; tools: string; ok: boolean; withheld: boolean; tokens: number; ms: number }> = [];
  for (const item of THAI_EVAL_SET) {
    const store = new MemoryAssistantJobStore();
    const reads: FixtureRead[] = [];
    const deps = {
      supabase: {} as SupabaseClient<Database>,
      store,
      provider,
      resolveScope: async () => ({ ok: true as const, scope: SUPERVISOR }),
      sourceAllowed: () => true,
      // The eval chat is a management group with a full group policy.
      resolveGroupPolicy: async (sourceId: string) => ({
        ok: true as const,
        policy: { sourceId, allowFinancial: true, allowPersonSpecific: true, markets: null },
      }),
      readData: createFixtureDataReader(reads),
    };
    const ask = async (question: string, n: number) => {
      await store.enqueue({
        lineEventId: `${item.id}-${n}`, rawMessageId: null, destination: "Ubot", sourceType: "group", sourceId: "Ceval",
        lineUserId: "Uboss", question, askedBusinessDate: THAI_EVAL_ASKED_DATE, eventTimestampMs: 1_793_000_000_000 + n,
        replyToken: null, replyTokenExpiresAt: null,
      });
      const [job] = await store.claim("eval", { limit: 1, leaseSeconds: 120, maxRunning: 5 });
      const answer = await answerAssistantJob(job!, { deadlineAt: Date.now() + 30_000, signal: new AbortController().signal }, deps);
      await store.recordAnswer(job!.id, job!.lease_token!, {
        answer: answer.text, kind: answer.kind ?? "answer", turn: answer.turn ?? null,
        scopeKey: answer.scopeKey ?? null, deliveryTarget: answer.deliverTo ?? "chat",
      });
      await store.complete(job!.id, job!.lease_token!, "completed");
      return answer;
    };
    const started = Date.now();
    try {
      if (item.previous) await ask(item.previous, 1);
      const before = reads.length;
      const answer = await ask(item.question, 2);
      const called = reads.slice(before).map((read) => read.request);
      const usage = (answer.usage ?? {}) as { inputTokens?: number; outputTokens?: number };
      const toolOk = item.expectedTool === null
        ? called.length === 0
        : called.some((request) => request.tool === item.expectedTool
          && Object.entries(item.expectedArgs ?? {}).every(([key, value]) =>
            String((request as unknown as Record<string, unknown>)[key] ?? "").includes(String(value))));
      rows.push({
        id: item.id,
        tools: called.map((request) => request.tool).join(",") || "-",
        ok: toolOk,
        withheld: answer.kind === "notice" && called.length > 0,
        tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        ms: Date.now() - started,
      });
    } catch (error) {
      rows.push({ id: item.id, tools: `error:${(error as Error).name}`, ok: false, withheld: false, tokens: 0, ms: Date.now() - started });
    }
  }
  return rows;
}

const pct = (n: number, d: number) => `${n}/${d} (${d ? Math.round((n / d) * 1000) / 10 : 0}%)`;

const a = sectionA();
const lines: string[] = [
  "# @Botsummary Thai evaluation — measured results",
  "",
  `Run at ${new Date().toISOString()} · ${THAI_EVAL_SET.length} questions · asked business date ${THAI_EVAL_ASKED_DATE} · fixture data only (no Production data).`,
  "",
  "## A. Deterministic backend rules",
  "",
  `- Business date: ${pct(a.filter((row) => row.date).length, a.length)}`,
  `- Follow-up detection: ${pct(a.filter((row) => row.followUp).length, a.length)}`,
  `- Staff authorization decision (asker = ดำ, market ราชพฤกษ์): ${pct(a.filter((row) => row.auth).length, a.length)}`,
  "",
  "| id | date | follow-up | auth | observed |",
  "|---|---|---|---|---|",
  ...a.map((row) => `| ${row.id} | ${row.date ? "✓" : "✗"} | ${row.followUp ? "✓" : "✗"} | ${row.auth ? "✓" : "✗"} | ${row.detail} |`),
];

const b = await pipeline(new ScriptedThaiModel());
lines.push(
  "",
  "## B. Pipeline harness with the scripted stand-in model (not GPT-6 Luna)",
  "",
  `- Expected tool executed: ${pct(b.filter((row) => row.ok).length, b.length)}`,
  `- Answers withheld by the grounding check: ${b.filter((row) => row.withheld).length}`,
  "",
  "| id | tools executed | expected? |",
  "|---|---|---|",
  ...b.map((row) => `| ${row.id} | ${row.tools} | ${row.ok ? "✓" : "✗"} |`),
);

if (process.argv.includes("--live")) {
  if (!process.env.OPENAI_API_KEY) {
    lines.push("", "## C. Live model", "", "Not run: OPENAI_API_KEY is not set.");
  } else {
    const provider = createOpenAIResponsesProvider();
    const c = await pipeline(provider);
    const tokens = c.reduce((sum, row) => sum + row.tokens, 0);
    lines.push(
      "",
      `## C. Live model: ${provider.model}`,
      "",
      `- Expected tool executed: ${pct(c.filter((row) => row.ok).length, c.length)}`,
      `- Answers withheld by the grounding check: ${c.filter((row) => row.withheld).length}`,
      `- Total tokens: ${tokens}; median latency ${[...c].sort((x, y) => x.ms - y.ms)[Math.floor(c.length / 2)]?.ms ?? 0} ms`,
      "",
      "| id | tools executed | expected? | ms |",
      "|---|---|---|---|",
      ...c.map((row) => `| ${row.id} | ${row.tools} | ${row.ok ? "✓" : "✗"} | ${row.ms} |`),
    );
  }
} else {
  lines.push("", "## C. Live model", "", "Not run (pass --live with OPENAI_API_KEY to measure GPT-6 Luna on the fixture data).");
}

const report = lines.join("\n") + "\n";
const outIndex = process.argv.indexOf("--out");
if (outIndex > 0 && process.argv[outIndex + 1]) writeFileSync(process.argv[outIndex + 1]!, report);
console.log(report);
